import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { contextFlag } from '../../lib/context-flags.js';
import { hashSecret, verifySecret } from '../../lib/sealed-secret.js';
import { logger } from '../../lib/logger.js';
import { createNominatimLookup, type NominatimLookup } from './nominatim.js';
import { parseEncryptKey, parseOwnTracksBody, unwrapOwnTracksPayload } from './owntracks.js';
import { derivePlaceVisits } from './place-visits.js';
import { purgeOldLocationPoints } from './retention.js';
import { householdIdForMember } from '../../lib/member-identity.js';
import { runWithHouseholdAsync } from '../../lib/tenancy.js';

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 60;

export class LocationIngestService {
  private hits = new Map<string, number[]>();
  private encryptKeys = new Map<string, Uint8Array>();
  rateLimitMax = RATE_MAX;

  constructor(
    private db: Database.Database,
    private nominatim: NominatimLookup = createNominatimLookup({ db }),
    private now: () => number = () => Date.now(),
  ) {
    this.loadEncryptKeys();
  }

  bootstrapFromEnv(env: NodeJS.ProcessEnv = process.env): void {
    const raw = env.LOCATION_DEVICES || '';
    for (const part of raw.split(',').map((item) => item.trim()).filter(Boolean)) {
      const [deviceId, memberSlug, secret] = part.split(':');
      if (!deviceId || !memberSlug || !secret) continue;
      const member = this.memberBySlug(memberSlug);
      if (!member) continue;
      this.upsertDevice(deviceId, member.id, secret);
    }
    this.loadEncryptKeys(env);
  }

  upsertDevice(deviceId: string, memberId: string, secret: string): void {
    const existing = this.db.prepare(
      'SELECT id FROM location_devices WHERE id = ?'
    ).get(deviceId) as { id: string } | undefined;
    const hashed = hashSecret(secret);
    if (existing) {
      this.db.prepare(
        'UPDATE location_devices SET member_id = ?, secret_salt = ?, secret_hash = ? WHERE id = ?'
      ).run(memberId, hashed.salt, hashed.hash, deviceId);
      return;
    }
    this.db.prepare(`
      INSERT INTO location_devices (id, household_id, member_id, secret_salt, secret_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(deviceId, householdIdForMember(this.db, memberId), memberId, hashed.salt, hashed.hash, this.now());
  }

  async ingest(
    headers: { authorization?: string | null },
    body: unknown
  ): Promise<{ status: number; accepted?: number; householdId?: string | null }> {
    if (!contextFlag('location')) return { status: 404 };
    const basic = parseBasic(headers.authorization);
    if (!basic) return { status: 401 };
    const device = this.db.prepare(
      'SELECT id, member_id, secret_salt, secret_hash FROM location_devices WHERE id = ?'
    ).get(basic.user) as
      | { id: string; member_id: string; secret_salt: string; secret_hash: string }
      | undefined;
    if (!device || !verifySecret(basic.pass, device.secret_salt, device.secret_hash)) {
      return { status: 401 };
    }
    if (this.overLimit(device.id)) return { status: 429 };

    let payload: unknown;
    try {
      payload = unwrapOwnTracksPayload(body, this.encryptKeys.get(device.id));
    } catch {
      return { status: 401 };
    }

    if (
      payload
      && typeof payload === 'object'
      && !Array.isArray(payload)
      && (payload as { _type?: string })._type
      && (payload as { _type?: string })._type !== 'location'
    ) {
      return { status: 202, accepted: 0 };
    }

    const householdId = householdIdForMember(this.db, device.member_id);
    const points = parseOwnTracksBody(payload);
    const received = this.now();
    let accepted = 0;
    for (const point of points) {
      this.db.prepare(`
        INSERT INTO location_points (
          id, household_id, member_id, device_id, lat, lng, accuracy_m, recorded_at, received_at, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        crypto.randomBytes(8).toString('hex'),
        householdId,
        device.member_id,
        device.id,
        point.lat,
        point.lon,
        point.acc ?? null,
        point.tst < 1e12 ? point.tst * 1000 : point.tst,
        received,
        JSON.stringify({ lat: point.lat, lon: point.lon, tst: point.tst, acc: point.acc }),
      );
      accepted += 1;
    }
    try {
      await runWithHouseholdAsync(householdId || 'hh-none', async () => {
        // Derived visits land in `place_visits`, the same sink webhook `place_visit` events write.
        await derivePlaceVisits(this.db, device.member_id, this.nominatim, received);
        purgeOldLocationPoints(this.db, received);
      });
    } catch (error) {
      logger.warn('Location post-process failed', { error: error instanceof Error ? error.message : String(error) });
    }
    return { status: 202, accepted, householdId };
  }

  private overLimit(deviceId: string): boolean {
    const now = this.now();
    const hits = (this.hits.get(deviceId) ?? []).filter((ts) => now - ts < RATE_WINDOW_MS);
    if (hits.length >= this.rateLimitMax) {
      this.hits.set(deviceId, hits);
      return true;
    }
    hits.push(now);
    this.hits.set(deviceId, hits);
    return false;
  }

  private loadEncryptKeys(env: NodeJS.ProcessEnv = process.env): void {
    this.encryptKeys.clear();
    const raw = env.LOCATION_ENCRYPT_KEYS || '';
    for (const part of raw.split(',').map((item) => item.trim()).filter(Boolean)) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      const deviceId = part.slice(0, eq);
      const key = parseEncryptKey(part.slice(eq + 1));
      if (key) this.encryptKeys.set(deviceId, key);
    }
  }

  private memberBySlug(slug: string): { id: string } | undefined {
    return this.db.prepare(
      'SELECT id FROM household_members WHERE id = ? OR lower(name) = lower(?)'
    ).get(slug, slug) as { id: string } | undefined;
  }
}

export function parseBasic(header?: string | null): { user: string; pass: string } | null {
  if (!header || !header.toLowerCase().startsWith('basic ')) return null;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx < 0) return null;
    return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}
