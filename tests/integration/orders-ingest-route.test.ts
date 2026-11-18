import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { runMigrations } from '../../src/server/db/migrations.js';
import { registerOrdersIngestRoute } from '../../src/server/routes/connections.js';
import { ConnectionsService } from '../../src/server/services/context/connections-service.js';
import { OrderMatchService } from '../../src/server/services/context/order-match.js';
import { OrderSyncStateStore } from '../../src/server/services/context/order-sync-state.js';
import { emailHmacHex } from '../../src/server/lib/email-hmac.js';
import { DEFAULT_HOUSEHOLD_ID } from '../../src/server/lib/tenancy.js';

const SECRET = 'test-only-hmac-secret';
const HH = DEFAULT_HOUSEHOLD_ID;

function line(overrides: Record<string, unknown> = {}) {
  return {
    shop: 'lazada',
    order_id: 'SYN-1001',
    placed_at: '2026-10-05',
    currency: 'SGD',
    total_cents: 2599,
    status: 'delivered',
    buyer_account: 'buyer@example.com',
    items: [
      { title: 'Synthetic notebook', qty: 2, unit_price_cents: 800, sku: 'SKU-1', url: 'https://example.com/p/1' },
      { title: 'Synthetic pen', qty: 1, unit_price_cents: 999, sku: null, url: null },
    ],
    ...overrides,
  };
}

describe('POST /api/ingest/orders (signed import)', () => {
  let db: Database.Database;
  let app: Hono<{ Variables: { authUser: string; householdId: string } }>;

  const post = (payload: unknown, opts: { secret?: string | null; signature?: string; recipient?: string; path?: string } = {}) => {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (opts.signature !== undefined) headers['X-OE-Signature'] = opts.signature;
    else if (opts.secret !== null) headers['X-OE-Signature'] = emailHmacHex(opts.secret ?? SECRET, Buffer.from(body));
    if (opts.recipient) headers['X-OE-Recipient'] = opts.recipient;
    return app.request(opts.path ?? '/api/ingest/orders', { method: 'POST', headers, body });
  };

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, { quiet: true });
    const now = Date.UTC(2026, 9, 1);
    db.prepare("INSERT OR IGNORE INTO households (id, name, currency, onboarding_step, created_at, updated_at) VALUES (?, 'Household', 'SGD', 'complete', ?, ?)").run(HH, now, now);
    db.prepare(`INSERT INTO accounts (id, household_id, name, aliases, account_group, created_at) VALUES ('card', ?, 'Card', '["card"]', 'credit', ?)`).run(HH, now);
    db.prepare(`
      INSERT INTO transactions (id, household_id, account_id, amount_cents, currency, timestamp, merchant_text, state, observation_ids, created_at, updated_at)
      VALUES ('tx-lz', ?, 'card', -2599, 'SGD', ?, 'LAZADA SG SINGAPORE SGP', 'posted', '[]', ?, ?)
    `).run(HH, Date.UTC(2026, 9, 7), now, now);
    app = new Hono();
    const connections = new ConnectionsService(db, { poll: async () => 0 } as never, {} as never);
    registerOrdersIngestRoute(app, {
      db,
      connections,
      triangulate: { forRecentTransactions: () => 0 },
      orderMatch: new OrderMatchService(db),
      hmacSecret: SECRET,
    });
  });
  afterEach(() => db.close());

  it('rejects a bad, missing-hex or wrong-secret signature with 401', async () => {
    expect((await post([line()], { signature: 'deadbeef' })).status).toBe(401);
    expect((await post([line()], { signature: 'a'.repeat(64) })).status).toBe(401);
    expect((await post([line()], { secret: 'other-secret' })).status).toBe(401);
    expect((db.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }).n).toBe(0);
  });

  it('falls back to the extension token path when unsigned (and rejects without a token)', async () => {
    expect((await post([line()], { secret: null })).status).toBe(401);
  });

  it('upserts, matches and reports counts; re-posting is idempotent', async () => {
    const payload = { orders: [line(), line({ shop: 'shopee', order_id: 'SYN-2002', total_cents: 450, items: [] }), { shop: 'nowhere' }] };
    const first = await post(payload);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ received: 3, rejected: 1, inserted: 2, updated: 0, matched: 1, unmatched: 1 });

    const row = db.prepare("SELECT merchant, status, buyer_account, matched_transaction_id, match_method FROM orders WHERE order_ref = 'SYN-1001'").get();
    expect(row).toEqual({ merchant: 'lazada', status: 'delivered', buyer_account: 'buyer@example.com', matched_transaction_id: 'tx-lz', match_method: 'exact' });
    const items = db.prepare("SELECT name, qty, unit_cents, line_cents, sku, url FROM order_items ORDER BY name").all();
    expect(items).toEqual([
      { name: 'Synthetic notebook', qty: 2, unit_cents: 800, line_cents: 1600, sku: 'SKU-1', url: 'https://example.com/p/1' },
      { name: 'Synthetic pen', qty: 1, unit_cents: 999, line_cents: 999, sku: null, url: null },
    ]);

    const again = await post(payload);
    expect(await again.json()).toEqual({ received: 3, rejected: 1, inserted: 0, updated: 2, matched: 1, unmatched: 1 });
    expect((db.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }).n).toBe(2);
    expect((db.prepare('SELECT COUNT(*) AS n FROM order_items').get() as { n: number }).n).toBe(2);
  });

  it('accepts a bare array and rejects malformed JSON or oversize batches', async () => {
    expect((await post([line()])).status).toBe(200);
    expect((await post('{not json')).status).toBe(400);
    expect((await post({ nope: true })).status).toBe(400);
    const big = Array.from({ length: 1001 }, (_, i) => line({ order_id: `SYN-${i}` }));
    expect((await post(big)).status).toBe(413);
  });

  it('rejects an unknown X-OE-Recipient like the email path', async () => {
    expect((await post([line()], { recipient: 'nobody@ingest.example.com' })).status).toBe(401);
  });

  it('requires X-OE-Recipient once there is more than one household', async () => {
    const now = Date.now();
    db.prepare("INSERT INTO households (id, name, currency, onboarding_step, created_at, updated_at) VALUES ('hh-2', 'Other', 'SGD', 'complete', ?, ?)").run(now, now);
    expect((await post([line()])).status).toBe(400);
  });

  it('records sync health so a dead session is visible', async () => {
    const path = '/api/ingest/orders/sync-status';
    expect((await post({ shop: 'shopee', state: 'reauth_needed' }, { path, signature: 'bad' })).status).toBe(401);
    expect((await post({ shop: 'shopee', state: 'sleeping' }, { path })).status).toBe(400);
    expect((await post({ shop: 'shopee', state: 'reauth_needed', detail: 'login page returned' }, { path })).status).toBe(200);
    const store = new OrderSyncStateStore(db);
    expect(store.list(HH)).toMatchObject([{ shop: 'shopee', state: 'reauth_needed', detail: 'login page returned', lastSuccessAt: null }]);
    await post({ shop: 'shopee', state: 'ok' }, { path });
    expect(store.list(HH)[0]).toMatchObject({ state: 'ok', detail: null });
    expect(store.list(HH)[0]!.lastSuccessAt).not.toBeNull();
  });
});
