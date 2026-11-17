import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/server/db/migrations.js';
import { hookHmacHex, hookTimestampFresh, verifyHookHmac } from '../../src/server/lib/hook-hmac.js';
import { jsonPathGet } from '../../src/server/services/context/json-path.js';
import { applyMapping } from '../../src/server/services/context/hook-mapping.js';
import { HooksService } from '../../src/server/services/context/hooks-service.js';
import { IngestEventPipeline } from '../../src/server/services/context/ingest-events.js';
import { purgeOldHookEvents, HOOK_EVENT_TTL_MS } from '../../src/server/services/context/retention.js';

const fixtures = join(process.cwd(), 'fixtures/context');

describe('webhook HMAC', () => {
  const secret = 'hook-secret';
  const body = Buffer.from('{"type":"note","version":1,"text":"hi"}');

  it('accepts a matching signature over timestamp+body', () => {
    const ts = '1760000000';
    const sig = hookHmacHex(secret, ts, body);
    expect(verifyHookHmac(secret, ts, body, `sha256=${sig}`)).toBe(true);
    expect(verifyHookHmac(secret, ts, body, 'ab'.repeat(32))).toBe(false);
    expect(verifyHookHmac(secret, ts, Buffer.from('nope'), `sha256=${sig}`)).toBe(false);
  });

  it('rejects timestamps outside the 300s replay window', () => {
    const now = 1_760_000_000_000;
    expect(hookTimestampFresh(String(Math.floor(now / 1000)), now)).toBe(true);
    expect(hookTimestampFresh(String(Math.floor(now / 1000) - 301), now)).toBe(false);
    expect(hookTimestampFresh(String(Math.floor(now / 1000) + 301), now)).toBe(false);
    expect(hookTimestampFresh('not-a-time', now)).toBe(false);
  });
});

describe('JSONPath mapping', () => {
  it('reads dotted paths, indexes, and maps item arrays', () => {
    const shop = JSON.parse(readFileSync(join(fixtures, 'webhook-mapped-shop.json'), 'utf8')) as unknown;
    const mapping = JSON.parse(readFileSync(join(fixtures, 'webhook-mapping.json'), 'utf8')) as Record<string, unknown>;
    expect(jsonPathGet(shop, '$.shop')).toBe('Lazada SG');
    expect(jsonPathGet(shop, '$.lines[0].title')).toBe('Notebook');
    const mapped = applyMapping(shop, mapping);
    expect(mapped.type).toBe('order');
    expect(mapped.order_id).toBe('LZ20261012999');
    expect(mapped.total).toBe(24.5);
    expect(mapped.items).toEqual([
      { name: 'Notebook', qty: 2, unit_price: 8.0 },
      { name: 'Pen set', qty: 1, unit_price: 8.5 },
    ]);
  });
});

describe('webhook ingest', () => {
  let db: Database.Database;
  let hooks: HooksService;
  let now: number;
  const previousWebhook = process.env.CONTEXT_WEBHOOK;
  const previousOrders = process.env.CONTEXT_ORDERS;

  beforeEach(() => {
    process.env.CONTEXT_WEBHOOK = '1';
    process.env.CONTEXT_ORDERS = '1';
    now = Date.UTC(2026, 9, 12, 2, 0, 0);
    db = new Database(':memory:');
    runMigrations(db, { quiet: true });
    db.prepare(
      "INSERT INTO household_members (id, name, email, created_at) VALUES ('mem-alex', 'Alex', 'alex@example.com', ?)",
    ).run(now);
    hooks = new HooksService(db, () => now);
  });

  afterEach(() => {
    if (previousWebhook === undefined) delete process.env.CONTEXT_WEBHOOK;
    else process.env.CONTEXT_WEBHOOK = previousWebhook;
    if (previousOrders === undefined) delete process.env.CONTEXT_ORDERS;
    else process.env.CONTEXT_ORDERS = previousOrders;
    db.close();
  });

  function mint() {
    return hooks.mint('mem-alex', 'Shortcuts', 'https://app.example.test');
  }

  it('accepts HMAC-signed typed orders and stores them as webhook evidence', () => {
    const minted = mint();
    const body = readFileSync(join(fixtures, 'webhook-order.json'));
    const ts = String(Math.floor(now / 1000));
    const sig = hookHmacHex(minted.secret, ts, body);
    const result = hooks.ingest(minted.id, {
      signature: `sha256=${sig}`,
      timestamp: ts,
    }, body);
    expect(result.status).toBe(202);
    expect(result.body).toMatchObject({ accepted: 1 });
    expect(result.body).not.toHaveProperty('duplicate');
    const order = db.prepare('SELECT merchant, order_ref, source, total_cents FROM orders').get() as {
      merchant: string;
      order_ref: string;
      source: string;
      total_cents: number;
    };
    expect(order).toEqual({
      merchant: 'lazada',
      order_ref: 'LZ20261012042',
      source: 'webhook',
      total_cents: 1290,
    });
    expect(db.prepare('SELECT COUNT(*) as n FROM ingest_hook_events').get()).toEqual({ n: 1 });
  });

  it('returns 401 with no body for a bad signature, unknown hook, or replayed timestamp', () => {
    const minted = mint();
    const body = readFileSync(join(fixtures, 'webhook-order.json'));
    const ts = String(Math.floor(now / 1000));
    const sig = hookHmacHex(minted.secret, ts, body);

    const badSig = hooks.ingest(minted.id, { signature: 'sha256=' + 'ab'.repeat(32), timestamp: ts }, body);
    expect(badSig).toEqual({ status: 401, body: null });

    const unknown = hooks.ingest('no-such-hook', { signature: `sha256=${sig}`, timestamp: ts }, body);
    expect(unknown).toEqual({ status: 401, body: null });

    const stale = hooks.ingest(minted.id, {
      signature: `sha256=${hookHmacHex(minted.secret, String(Math.floor(now / 1000) - 400), body)}`,
      timestamp: String(Math.floor(now / 1000) - 400),
    }, body);
    expect(stale).toEqual({ status: 401, body: null });
  });

  it('rejects a reused HMAC signature inside the replay window', () => {
    const minted = mint();
    const body = readFileSync(join(fixtures, 'webhook-order.json'));
    const ts = String(Math.floor(now / 1000));
    const sig = hookHmacHex(minted.secret, ts, body);
    const first = hooks.ingest(minted.id, { signature: `sha256=${sig}`, timestamp: ts }, body);
    expect(first.status).toBe(202);
    const replay = hooks.ingest(minted.id, { signature: `sha256=${sig}`, timestamp: ts }, body);
    expect(replay).toEqual({ status: 401, body: null });
  });

  it('is idempotent on event_id for bearer clients', () => {
    const minted = mint();
    const body = readFileSync(join(fixtures, 'webhook-order.json'));
    const first = hooks.ingest(minted.id, { authorization: `Bearer ${minted.secret}` }, body);
    const second = hooks.ingest(minted.id, { authorization: `Bearer ${minted.secret}` }, body);
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ accepted: 1 });
    expect(second).toEqual({ status: 202, body: { accepted: 0, duplicate: true } });
    expect(db.prepare('SELECT COUNT(*) as n FROM orders').get()).toEqual({ n: 1 });
  });

  it('maps arbitrary shop JSON through a per-hook JSONPath template', () => {
    const minted = mint();
    const mapping = readFileSync(join(fixtures, 'webhook-mapping.json'), 'utf8');
    expect(hooks.saveMapping('mem-alex', minted.id, mapping)).toEqual({ ok: true });
    const body = readFileSync(join(fixtures, 'webhook-mapped-shop.json'));
    const result = hooks.ingest(minted.id, { authorization: `Bearer ${minted.secret}` }, body);
    expect(result.status).toBe(202);
    expect(result.body).toMatchObject({ accepted: 1 });
    const order = db.prepare('SELECT merchant, order_ref, total_cents FROM orders').get() as {
      merchant: string;
      order_ref: string;
      total_cents: number;
    };
    expect(order).toEqual({
      merchant: 'lazada',
      order_ref: 'LZ20261012999',
      total_cents: 2450,
    });
    const items = db.prepare('SELECT name, qty, unit_cents FROM order_items ORDER BY name').all() as Array<{
      name: string;
      qty: number;
      unit_cents: number;
    }>;
    expect(items).toEqual([
      { name: 'Notebook', qty: 2, unit_cents: 800 },
      { name: 'Pen set', qty: 1, unit_cents: 850 },
    ]);
    const listed = hooks.list('mem-alex', 'https://app.example.test');
    expect(listed[0]?.preview).toMatchObject({ type: 'order', order_id: 'LZ20261012999' });
  });

  it('records txn_alert observations without creating transactions', () => {
    const minted = mint();
    const body = readFileSync(join(fixtures, 'webhook-txn-alert.json'));
    const result = hooks.ingest(minted.id, { authorization: `Bearer ${minted.secret}` }, body);
    expect(result.status).toBe(202);
    expect(result.body).toMatchObject({ accepted: 1 });
    const obs = db.prepare(
      'SELECT adapter_name, is_statement, amount_cents, merchant_text FROM observations',
    ).get() as { adapter_name: string; is_statement: number; amount_cents: number; merchant_text: string };
    expect(obs.adapter_name).toBe('webhook-alert');
    expect(obs.is_statement).toBe(0);
    expect(obs.amount_cents).toBe(-1290);
    expect(obs.merchant_text).toBe('LAZADA SG');
    expect(db.prepare('SELECT COUNT(*) as n FROM transactions').get()).toEqual({ n: 0 });
  });

  it.skip('rate-limits a hook', () => {
    const minted = mint();
    const body = Buffer.from(JSON.stringify({ type: 'note', version: 1, text: 'x', event_id: 'n1' }));
    for (let i = 0; i < 60; i++) {
      hooks.ingest(minted.id, { authorization: `Bearer ${minted.secret}` }, body);
    }
    const extra = hooks.ingest(minted.id, { authorization: `Bearer ${minted.secret}` }, body);
    expect(extra.status).toBe(429);
  });
});

describe('ingest event pipeline', () => {
  it('writes place_visit and calendar_event into the same tables OwnTracks/iCal use', () => {
    process.env.CONTEXT_WEBHOOK = '1';
    const db = new Database(':memory:');
    runMigrations(db, { quiet: true });
    const now = Date.UTC(2026, 9, 12, 4, 0, 0);
    db.prepare(
      "INSERT INTO household_members (id, name, email, created_at) VALUES ('mem-alex', 'Alex', 'a@example.com', ?)",
    ).run(now);
    const pipeline = new IngestEventPipeline(db, () => now);
    const place = pipeline.dispatch('mem-alex', [{
      type: 'place_visit',
      version: 1,
      place_name: 'Jewel Changi',
      arrived_at: now - 20 * 60 * 1000,
      left_at: now,
    }], 'webhook');
    const cal = pipeline.dispatch('mem-alex', [{
      type: 'calendar_event',
      version: 1,
      event_id: 'dinner-1',
      title: 'Dinner',
      location: 'Jewel',
      starts_at: now,
      ends_at: now + 3600_000,
    }], 'webhook');
    expect(place.accepted).toBe(1);
    expect(cal.accepted).toBe(1);
    expect(db.prepare("SELECT place_source FROM place_visits").get()).toEqual({ place_source: 'webhook' });
    expect(db.prepare('SELECT title FROM calendar_events').get()).toEqual({ title: 'Dinner' });
    db.close();
  });
});

describe('hook event retention', () => {
  it('purges raw payloads after 30 days', () => {
    const db = new Database(':memory:');
    runMigrations(db, { quiet: true });
    const now = Date.UTC(2026, 9, 14);
    db.prepare(
      "INSERT INTO household_members (id, name, email, created_at) VALUES ('mem-alex', 'Alex', 'a@example.com', ?)",
    ).run(now);
    db.prepare(`
      INSERT INTO ingest_hooks (id, household_id, member_id, name, secret_enc, created_at, received_count, error_count)
      VALUES ('hook-1', 'hh-1', 'mem-alex', 'Test', 'enc', ?, 0, 0)
    `).run(now);
    db.prepare(`
      INSERT INTO ingest_hook_events (id, household_id, hook_id, event_key, status, raw_json, received_at)
      VALUES ('old', 'hh-1', 'hook-1', 'hash:old', 'accepted', '{}', ?)
    `).run(now - HOOK_EVENT_TTL_MS - 1000);
    db.prepare(`
      INSERT INTO ingest_hook_events (id, household_id, hook_id, event_key, status, raw_json, received_at)
      VALUES ('new', 'hh-1', 'hook-1', 'hash:new', 'accepted', '{}', ?)
    `).run(now);
    expect(purgeOldHookEvents(db, now)).toBe(1);
    expect(db.prepare('SELECT id FROM ingest_hook_events').all()).toEqual([{ id: 'new' }]);
    db.close();
  });
});
