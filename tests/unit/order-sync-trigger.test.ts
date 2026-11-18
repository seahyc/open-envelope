import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createHmac } from 'node:crypto';
import { runMigrations } from '../../src/server/db/migrations.js';
import { OrderSyncTrigger, type ShopChargeEvent } from '../../src/server/services/context/order-sync-trigger.js';
import { OrderMatchService } from '../../src/server/services/context/order-match.js';
import { OrdersIngestService } from '../../src/server/services/context/orders-ingest.js';

const NOW = Date.UTC(2026, 10, 18, 4);

function recorder() {
  const calls: Array<{ url: string; body: string; signature: string }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: String(init.body), signature: (init.headers as Record<string, string>)['X-OE-Signature']! });
    return new Response('{}', { status: 202 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const charge = (shop: ShopChargeEvent['shop'], ageMs = 60_000): ShopChargeEvent => ({ shop, transactionId: `tx-${shop}`, timestamp: NOW - ageMs, amountCents: -1000 });

describe('OrderSyncTrigger', () => {
  it('is a no-op unless a URL and secret are configured', () => {
    const { calls, fetchImpl } = recorder();
    expect(new OrderSyncTrigger({ fetchImpl, now: () => NOW }).request(charge('shopee'))).toBe(false);
    expect(new OrderSyncTrigger({ url: 'http://sync:8787/trigger', fetchImpl, now: () => NOW }).request(charge('shopee'))).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('sends a signed request, debounced per shop, and ignores stale back-filled charges', () => {
    const { calls, fetchImpl } = recorder();
    let now = NOW;
    const trigger = new OrderSyncTrigger({ url: 'http://sync:8787/trigger', secret: 's3cret', fetchImpl, now: () => now, debounceMs: 600_000 });
    expect(trigger.request(charge('shopee'))).toBe(true);
    expect(trigger.request(charge('shopee'))).toBe(false);
    expect(trigger.request(charge('lazada'))).toBe(true);
    expect(trigger.request(charge('amazon', 10 * 24 * 3600_000))).toBe(false);
    now += 600_001;
    expect(trigger.request(charge('shopee'))).toBe(true);
    expect(calls.map((call) => JSON.parse(call.body).shop)).toEqual(['shopee', 'lazada', 'shopee']);
    for (const call of calls) {
      expect(call.signature).toBe(createHmac('sha256', 's3cret').update(call.body).digest('hex'));
    }
  });
});

describe('unexplainedShopCharges', () => {
  it('lists marketplace outflows that no order explains yet', () => {
    const db = new Database(':memory:');
    runMigrations(db, { quiet: true });
    db.exec(`INSERT INTO accounts (id, name, aliases, account_group, created_at) VALUES ('card', 'Card', '[]', 'credit', 0), ('cpf', 'P', '[]', 'tracking', 0)`);
    const add = db.prepare(`INSERT INTO transactions (id, account_id, amount_cents, currency, timestamp, merchant_text, state, observation_ids, created_at, updated_at)
      VALUES (?, ?, ?, 'SGD', ?, ?, 'posted', '[]', 0, 0)`);
    add.run('t-shopee', 'card', -1500, NOW, 'SHOPEE SG MP');
    add.run('t-matched', 'card', -2500, NOW, 'LAZADA SG');
    add.run('t-cafe', 'card', -500, NOW, 'KOPI SHOP');
    add.run('t-refund', 'card', 900, NOW, 'AMAZON MKTPLC SG');
    add.run('t-tracking', 'cpf', -900, NOW, 'AMAZON MKTPLC SG');
    new OrdersIngestService(db).ingest('', [{ merchant: 'lazada', order_id: 'L1', placed_at: NOW, total_cents: 2500, currency: 'SGD', items: [] }], 'import');
    new OrderMatchService(db).matchHousehold();
    const events = new OrderMatchService(db).unexplainedShopCharges(['t-shopee', 't-matched', 't-cafe', 't-refund', 't-tracking']);
    expect(events).toEqual([{ shop: 'shopee', transactionId: 't-shopee', timestamp: NOW, amountCents: -1500 }]);
    db.close();
  });
});
