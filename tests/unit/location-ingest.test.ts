import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/server/db/migrations.js';
import { LocationIngestService } from '../../src/server/services/context/location-ingest.js';
import { createNominatimLookup } from '../../src/server/services/context/nominatim.js';
import { encryptOwnTracksPayload, parseEncryptKey } from '../../src/server/services/context/owntracks.js';
import { purgeOldLocationPoints, LOCATION_POINT_TTL_MS } from '../../src/server/services/context/retention.js';
import { derivePlaceVisits } from '../../src/server/services/context/place-visits.js';

const SECRET = 'device-secret-1';
const KEY = Buffer.alloc(32, 7);

function basic(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

describe('OwnTracks location ingest', () => {
  let db: Database.Database;
  let service: LocationIngestService;
  const previous = process.env.CONTEXT_LOCATION;

  beforeEach(() => {
    process.env.CONTEXT_LOCATION = '1';
    db = new Database(':memory:');
    runMigrations(db, { quiet: true });
    db.prepare(
      "INSERT INTO household_members (id, name, email, created_at) VALUES ('mem-alex', 'Alex', 'alex@example.com', ?)"
    ).run(Date.now());
    const nominatim = createNominatimLookup({
      db,
      fetchImpl: (async () => new Response(JSON.stringify({ name: 'Jewel Changi' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch,
    });
    service = new LocationIngestService(db, nominatim, () => Date.UTC(2026, 9, 14, 14, 30, 0));
    service.upsertDevice('alex-iphone', 'mem-alex', SECRET);
    process.env.LOCATION_ENCRYPT_KEYS = `alex-iphone=${KEY.toString('base64')}`;
    service.bootstrapFromEnv();
    service.upsertDevice('alex-iphone', 'mem-alex', SECRET);
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.CONTEXT_LOCATION;
    else process.env.CONTEXT_LOCATION = previous;
    delete process.env.LOCATION_ENCRYPT_KEYS;
    db.close();
  });

  it('rejects missing basic with 401 empty', async () => {
    const result = await service.ingest({}, { _type: 'location', lat: 1.36, lon: 103.98, tst: 1_771_000_000 });
    expect(result.status).toBe(401);
  });

  it('rejects unknown device with 401', async () => {
    const result = await service.ingest(
      { authorization: basic('nope', SECRET) },
      { _type: 'location', lat: 1.36, lon: 103.98, tst: 1_771_000_000 },
    );
    expect(result.status).toBe(401);
  });

  it('rejects the wrong device secret with 401', async () => {
    const result = await service.ingest(
      { authorization: basic('alex-iphone', 'not-the-secret') },
      { _type: 'location', lat: 1.36, lon: 103.98, tst: 1_771_000_000 },
    );
    expect(result.status).toBe(401);
  });

  it('returns 404 when the flag is off', async () => {
    process.env.CONTEXT_LOCATION = '0';
    const result = await service.ingest(
      { authorization: basic('alex-iphone', SECRET) },
      { _type: 'location', lat: 1.36, lon: 103.98, tst: 1_771_000_000 },
    );
    expect(result.status).toBe(404);
  });

  it('accepts a location point and derives a place visit', async () => {
    const base = Math.floor(Date.UTC(2026, 9, 14, 14, 10, 0) / 1000);
    const points = [0, 4, 8, 12].map((min) => ({
      _type: 'location',
      lat: 1.3603,
      lon: 103.9896,
      tst: base + min * 60,
    }));
    const result = await service.ingest({ authorization: basic('alex-iphone', SECRET) }, points);
    expect(result.status).toBe(202);
    expect(result.accepted).toBe(4);
    const visits = db.prepare('SELECT place_name FROM place_visits').all() as Array<{ place_name: string }>;
    expect(visits[0]?.place_name).toBe('Jewel Changi');
  });

  it('ignores non-location types with 202', async () => {
    const result = await service.ingest(
      { authorization: basic('alex-iphone', SECRET) },
      { _type: 'lwt', tst: 1_771_000_000 },
    );
    expect(result.status).toBe(202);
    expect(result.accepted).toBe(0);
  });

  it('decrypts an encrypted OwnTracks payload', async () => {
    const payload = { _type: 'location', lat: 1.36, lon: 103.99, tst: 1_771_000_000 };
    const data = encryptOwnTracksPayload(payload, new Uint8Array(KEY));
    const result = await service.ingest(
      { authorization: basic('alex-iphone', SECRET) },
      { _type: 'encrypted', data },
    );
    expect(result.status).toBe(202);
    expect(result.accepted).toBe(1);
  });

  it('decrypts with an OwnTracks passphrase from LOCATION_ENCRYPT_KEYS', async () => {
    const pass = 'device-passphrase-1';
    process.env.LOCATION_ENCRYPT_KEYS = `alex-iphone=${pass}`;
    service.bootstrapFromEnv();
    service.upsertDevice('alex-iphone', 'mem-alex', SECRET);
    const key = parseEncryptKey(pass)!;
    const payload = { _type: 'location', lat: 1.36, lon: 103.99, tst: 1_771_000_000 };
    const data = encryptOwnTracksPayload(payload, key);
    const result = await service.ingest(
      { authorization: basic('alex-iphone', SECRET) },
      { _type: 'encrypted', data },
    );
    expect(result.status).toBe(202);
    expect(result.accepted).toBe(1);
  });

  it('rejects a secretbox that does not open with 401', async () => {
    const result = await service.ingest(
      { authorization: basic('alex-iphone', SECRET) },
      { _type: 'encrypted', data: Buffer.alloc(48, 3).toString('base64') },
    );
    expect(result.status).toBe(401);
  });

  it('accepts an offline-queue array of encrypted locations', async () => {
    const loc = { _type: 'location', lat: 1.36, lon: 103.99, tst: 1_771_000_000 };
    const data = encryptOwnTracksPayload(loc, new Uint8Array(KEY));
    const result = await service.ingest(
      { authorization: basic('alex-iphone', SECRET) },
      [{ _type: 'encrypted', data }, { _type: 'lwt', tst: 1_771_000_001 }],
    );
    expect(result.status).toBe(202);
    expect(result.accepted).toBe(1);
  });

  it('rate-limits a device', async () => {
    service.rateLimitMax = 2;
    const body = { _type: 'location', lat: 1.36, lon: 103.99, tst: 1_771_000_000 };
    const auth = { authorization: basic('alex-iphone', SECRET) };
    expect((await service.ingest(auth, body)).status).toBe(202);
    expect((await service.ingest(auth, body)).status).toBe(202);
    expect((await service.ingest(auth, body)).status).toBe(429);
  });

  it('purges raw points older than 90 days and keeps visits', async () => {
    const now = Date.UTC(2026, 9, 14);
    db.prepare(`
      INSERT INTO location_points (
        id, member_id, device_id, lat, lng, recorded_at, received_at
      ) VALUES ('old-pt', 'mem-alex', 'alex-iphone', 1.36, 103.99, ?, ?)
    `).run(now - LOCATION_POINT_TTL_MS - 1000, now);
    db.prepare(`
      INSERT INTO place_visits (
        id, member_id, lat, lng, arrived_at, left_at, place_name, place_source, created_at
      ) VALUES ('visit-1', 'mem-alex', 1.36, 103.99, ?, ?, 'Jewel Changi', 'nominatim', ?)
    `).run(now - LOCATION_POINT_TTL_MS - 1000, now - LOCATION_POINT_TTL_MS, now);
    expect(purgeOldLocationPoints(db, now)).toBe(1);
    expect(db.prepare('SELECT COUNT(*) as n FROM location_points').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) as n FROM place_visits').get()).toEqual({ n: 1 });
  });

  it('does not call Nominatim under VITEST without a fetch mock', async () => {
    const lookup = createNominatimLookup({ db });
    expect(await lookup.reverse(1.36, 103.99)).toBeNull();
    const now = Date.UTC(2026, 9, 14, 14, 20, 0);
    db.prepare(`
      INSERT INTO location_points (id, member_id, device_id, lat, lng, recorded_at, received_at)
      VALUES ('p1', 'mem-alex', 'alex-iphone', 1.36, 103.99, ?, ?),
             ('p2', 'mem-alex', 'alex-iphone', 1.36, 103.99, ?, ?)
    `).run(now, now, now + 10 * 60 * 1000, now);
    const created = await derivePlaceVisits(db, 'mem-alex', lookup, now);
    expect(created).toBe(1);
    expect(db.prepare('SELECT place_name FROM place_visits').get()).toEqual({ place_name: null });
  });
});
