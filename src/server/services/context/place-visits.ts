import crypto from 'crypto';
import type Database from 'better-sqlite3';
import type { NominatimLookup } from './nominatim.js';
import { householdIdForMember } from '../../lib/member-identity.js';
import { hh } from '../../lib/tenancy.js';

const CLUSTER_METERS = 120;
const MAX_GAP_MS = 15 * 60 * 1000;
const MIN_DWELL_MS = 8 * 60 * 1000;

export function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sin = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(sin)));
}

export async function derivePlaceVisits(
  db: Database.Database,
  memberId: string,
  nominatim: NominatimLookup,
  now = Date.now()
): Promise<number> {
  const points = db.prepare(`
    SELECT lat, lng, recorded_at
    FROM location_points
    WHERE member_id = ?
    ORDER BY recorded_at ASC
  `).all(memberId) as Array<{ lat: number; lng: number; recorded_at: number }>;

  let created = 0;
  let cluster: Array<{ lat: number; lng: number; recorded_at: number }> = [];

  async function flush() {
    if (cluster.length === 0) return;
    const first = cluster[0]!;
    const last = cluster[cluster.length - 1]!;
    if (last.recorded_at - first.recorded_at < MIN_DWELL_MS) {
      cluster = [];
      return;
    }
    const lat = cluster.reduce((sum, p) => sum + p.lat, 0) / cluster.length;
    const lng = cluster.reduce((sum, p) => sum + p.lng, 0) / cluster.length;
    const overlap = db.prepare(`
      SELECT id FROM place_visits
      WHERE member_id = ?
        AND ABS(lat - ?) < 0.002 AND ABS(lng - ?) < 0.002
        AND arrived_at <= ? AND left_at >= ?
    `).get(memberId, lat, lng, last.recorded_at, first.recorded_at) as { id: string } | undefined;
    if (overlap) {
      db.prepare(
        'UPDATE place_visits SET left_at = MAX(left_at, ?), arrived_at = MIN(arrived_at, ?) WHERE id = ?'
      ).run(last.recorded_at, first.recorded_at, overlap.id);
      cluster = [];
      return;
    }
    const placeName = await nominatim.reverse(lat, lng);
    db.prepare(`
      INSERT INTO place_visits (
        id, household_id, member_id, lat, lng, arrived_at, left_at, place_name, place_source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomBytes(8).toString('hex'),
      householdIdForMember(db, memberId) ?? hh(),
      memberId,
      lat,
      lng,
      first.recorded_at,
      last.recorded_at,
      placeName,
      placeName ? 'nominatim' : null,
      now
    );
    created += 1;
    cluster = [];
  }

  for (const point of points) {
    if (cluster.length === 0) {
      cluster.push(point);
      continue;
    }
    const anchor = cluster[0]!;
    const prev = cluster[cluster.length - 1]!;
    const near = haversineMeters(anchor, point) <= CLUSTER_METERS;
    const recent = point.recorded_at - prev.recorded_at <= MAX_GAP_MS;
    if (near && recent) {
      cluster.push(point);
    } else {
      await flush();
      cluster = [point];
    }
  }
  await flush();
  return created;
}
