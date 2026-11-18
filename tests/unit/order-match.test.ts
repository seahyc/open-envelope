import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/server/db/migrations.js';
import { OrdersIngestService, parsePlacedAt, type IngestOrder } from '../../src/server/services/context/orders-ingest.js';
import { OrderMatchService, shopForMerchantText } from '../../src/server/services/context/order-match.js';
import { KeywordItemHinter } from '../../src/server/services/context/item-hints.js';
import { CategoriserService } from '../../src/server/categoriser/service.js';
import { DEFAULT_HOUSEHOLD_ID } from '../../src/server/lib/tenancy.js';

const DAY = 24 * 60 * 60 * 1000;
const HH = DEFAULT_HOUSEHOLD_ID;

function setup() {
  const db = new Database(':memory:');
  runMigrations(db, { quiet: true });
  const now = Date.UTC(2026, 9, 1);
  db.prepare(`INSERT INTO accounts (id, household_id, name, aliases, account_group, created_at) VALUES
    ('card', ?, 'Card', '["card"]', 'credit', ?),
    ('bank', ?, 'Bank', '["bank"]', 'budget', ?),
    ('cpf', ?, 'Pension', '["cpf"]', 'tracking', ?)`).run(HH, now, HH, now, HH, now);
  return db;
}

let txSeq = 0;
function addTx(db: Database.Database, opts: { amount: number; at: number; merchant: string; account?: string; currency?: string; category?: string | null }) {
  const id = `tx-${++txSeq}`;
  db.prepare(`
    INSERT INTO transactions (id, household_id, account_id, amount_cents, currency, timestamp, merchant_text, state, category, observation_ids, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'posted', ?, '[]', ?, ?)
  `).run(id, HH, opts.account ?? 'card', opts.amount, opts.currency ?? 'SGD', opts.at, opts.merchant, opts.category ?? null, opts.at, opts.at);
  return id;
}

function order(shop: string, id: string, placed: string | null, total: number, items: IngestOrder['items'] = [{ name: 'Widget', qty: 1, unit_cents: total, line_cents: total }]): IngestOrder {
  return { merchant: shop, order_id: id, placed_at: placed, currency: 'SGD', total_cents: total, status: 'completed', items };
}

function matchedTx(db: Database.Database, orderRef: string): string | null {
  const row = db.prepare('SELECT matched_transaction_id AS t FROM orders WHERE order_ref = ?').get(orderRef) as { t: string | null };
  return row.t;
}

const at = (ymd: string, plusDays = 0) => (parsePlacedAt(ymd) as number) + plusDays * DAY + 12 * 60 * 60 * 1000;

describe('shopForMerchantText', () => {
  it('recognises marketplace descriptors and their variants', () => {
    expect(shopForMerchantText('AMAZON MKTPLC SG SINGAPORE SGP')).toBe('amazon');
    expect(shopForMerchantText('AMAZON MARKETPLACE SG SINGAPORE SGP')).toBe('amazon');
    expect(shopForMerchantText('AMZN MKTP SG')).toBe('amazon');
    expect(shopForMerchantText('LAZADA SG SINGAPORE SGP')).toBe('lazada');
    expect(shopForMerchantText('Lazada SG SINGAPORE SGP')).toBe('lazada');
    expect(shopForMerchantText('DEBIT PURCHASE 01/01/26 xx-0000 LAZADA SINGAPORE (Paym')).toBe('lazada');
    expect(shopForMerchantText('SHOPEE SG MP SINGAPORE SG')).toBe('shopee');
    expect(shopForMerchantText('SHOPEEPAY TOPUP')).toBe('shopee');
    expect(shopForMerchantText('SEA LIMITED SINGAPORE')).toBe('shopee');
  });

  it('does not confuse card-wrapper prefixes or memberships with Amazon orders', () => {
    expect(shopForMerchantText('AMAZE* SOME CAFE SINGAPORE SGP')).toBeNull();
    expect(shopForMerchantText('AMZNPRIMESG MEMBERSHI SINGAPORE SGP')).toBeNull();
    expect(shopForMerchantText('AMAZON PRIME SG')).toBeNull();
    expect(shopForMerchantText('KOPI SHOP')).toBeNull();
  });
});

describe('OrderMatchService', () => {
  let db: Database.Database;
  let ingest: OrdersIngestService;
  let matcher: OrderMatchService;

  beforeEach(() => {
    db = setup();
    ingest = new OrdersIngestService(db, () => Date.UTC(2026, 10, 1));
    matcher = new OrderMatchService(db, () => Date.UTC(2026, 10, 1));
  });
  afterEach(() => db.close());

  it('links an order to the exact-amount outflow inside -2..+10 days', () => {
    const tx = addTx(db, { amount: -2599, at: at('2026-10-05', 3), merchant: 'LAZADA SG SINGAPORE SGP' });
    ingest.ingest('', [order('lazada', 'L-1', '2026-10-05', 2599)], 'import');
    const summary = matcher.matchHousehold();
    expect(summary).toMatchObject({ exact: 1, unmatched: 0 });
    expect(matchedTx(db, 'L-1')).toBe(tx);
    const method = db.prepare("SELECT match_method FROM orders WHERE order_ref = 'L-1'").get() as { match_method: string };
    expect(method.match_method).toBe('exact');
  });

  it('respects the window edges', () => {
    addTx(db, { amount: -1000, at: at('2026-10-05', 11), merchant: 'SHOPEE SG MP' });
    addTx(db, { amount: -2000, at: at('2026-10-05', -3), merchant: 'SHOPEE SG MP' });
    const inside = addTx(db, { amount: -3000, at: at('2026-10-05', -1), merchant: 'SHOPEE SG MP' });
    ingest.ingest('', [
      order('shopee', 'S-late', '2026-10-05', 1000),
      order('shopee', 'S-early', '2026-10-05', 2000),
      order('shopee', 'S-inside', '2026-10-05', 3000),
    ], 'import');
    matcher.matchHousehold();
    expect(matchedTx(db, 'S-late')).toBeNull();
    expect(matchedTx(db, 'S-early')).toBeNull();
    expect(matchedTx(db, 'S-inside')).toBe(inside);
  });

  it('requires a card/bank account, an outflow, the same shop and currency', () => {
    addTx(db, { amount: -500, at: at('2026-10-05'), merchant: 'SHOPEE SG MP', account: 'cpf' });
    addTx(db, { amount: 500, at: at('2026-10-05'), merchant: 'SHOPEE SG MP' });
    addTx(db, { amount: -500, at: at('2026-10-05'), merchant: 'LAZADA SG' });
    addTx(db, { amount: -500, at: at('2026-10-05'), merchant: 'SHOPEE SG MP', currency: 'USD' });
    addTx(db, { amount: -500, at: at('2026-10-05'), merchant: 'AMAZE* SHOPPING' });
    ingest.ingest('', [order('shopee', 'S-1', '2026-10-05', 500)], 'import');
    expect(matcher.matchHousehold().unmatched).toBe(1);
    expect(matchedTx(db, 'S-1')).toBeNull();
  });

  it('leaves orders without a date unmatched (never invents one for imports)', () => {
    addTx(db, { amount: -700, at: Date.UTC(2026, 10, 1), merchant: 'AMAZON MKTPLC SG' });
    ingest.ingest('', [order('amazon', 'A-1', null, 700)], 'import');
    const row = db.prepare("SELECT ordered_at, merchant FROM orders WHERE order_ref = 'A-1'").get() as { ordered_at: number | null; merchant: string };
    expect(row.ordered_at).toBeNull();
    expect(row.merchant).toBe('amazon_sg');
    matcher.matchHousehold();
    expect(matchedTx(db, 'A-1')).toBeNull();
  });

  it('does not guess between ambiguous candidates', () => {
    // Two identical orders and two identical charges: no way to know which is which.
    addTx(db, { amount: -1500, at: at('2026-10-05', 1), merchant: 'SHOPEE SG MP' });
    addTx(db, { amount: -1500, at: at('2026-10-05', 2), merchant: 'SHOPEE SG MP' });
    ingest.ingest('', [order('shopee', 'S-a', '2026-10-05', 1500), order('shopee', 'S-b', '2026-10-05', 1500)], 'import');
    // One order, two equal charges.
    addTx(db, { amount: -999, at: at('2026-10-05', 1), merchant: 'LAZADA SG' });
    addTx(db, { amount: -999, at: at('2026-10-05', 4), merchant: 'LAZADA SG' });
    ingest.ingest('', [order('lazada', 'L-x', '2026-10-05', 999)], 'import');
    const summary = matcher.matchHousehold();
    expect(summary.exact).toBe(0);
    expect(summary.ambiguous).toBe(3);
    expect(matchedTx(db, 'S-a')).toBeNull();
    expect(matchedTx(db, 'S-b')).toBeNull();
    expect(matchedTx(db, 'L-x')).toBeNull();
  });

  it('pairs same-amount orders that are far enough apart to be unambiguous', () => {
    const t1 = addTx(db, { amount: -1200, at: at('2026-10-01', 1), merchant: 'SHOPEE SG MP' });
    const t2 = addTx(db, { amount: -1200, at: at('2026-10-20', 1), merchant: 'SHOPEE SG MP' });
    ingest.ingest('', [order('shopee', 'S-early', '2026-10-01', 1200), order('shopee', 'S-late', '2026-10-20', 1200)], 'import');
    matcher.matchHousehold();
    expect(matchedTx(db, 'S-early')).toBe(t1);
    expect(matchedTx(db, 'S-late')).toBe(t2);
  });

  it('matches one charge covering several orders placed together (many-to-one)', () => {
    const tx = addTx(db, { amount: -4500, at: at('2026-10-05', 1), merchant: 'SHOPEE SG MP' });
    ingest.ingest('', [
      order('shopee', 'S-1', '2026-10-05', 1000),
      order('shopee', 'S-2', '2026-10-05', 3500),
      order('shopee', 'S-far', '2026-09-30', 2000),
    ], 'import');
    const summary = matcher.matchHousehold();
    expect(summary.grouped).toBe(2);
    expect(matchedTx(db, 'S-1')).toBe(tx);
    expect(matchedTx(db, 'S-2')).toBe(tx);
    expect(matchedTx(db, 'S-far')).toBeNull();
    const methods = db.prepare("SELECT DISTINCT match_method AS m FROM orders WHERE matched_transaction_id IS NOT NULL").all();
    expect(methods).toEqual([{ m: 'group' }]);
  });

  it('skips many-to-one when more than one combination fits', () => {
    addTx(db, { amount: -3000, at: at('2026-10-05', 1), merchant: 'SHOPEE SG MP' });
    ingest.ingest('', [
      order('shopee', 'S-1', '2026-10-05', 1000),
      order('shopee', 'S-2', '2026-10-05', 2000),
      order('shopee', 'S-3', '2026-10-05', 1000),
    ], 'import');
    const summary = matcher.matchHousehold();
    expect(summary.grouped).toBe(0);
    expect(summary.unmatched).toBe(3);
  });

  it('matches later when the charge arrives after the order', () => {
    ingest.ingest('', [order('amazon', 'A-9', '2026-10-05', 4321)], 'import');
    expect(matcher.matchHousehold().unmatched).toBe(1);
    const tx = addTx(db, { amount: -4321, at: at('2026-10-05', 6), merchant: 'AMAZON MKTPLC SG SINGAPORE SGP' });
    expect(matcher.matchHousehold().exact).toBe(1);
    expect(matchedTx(db, 'A-9')).toBe(tx);
  });

  it('re-ingest is idempotent and a changed total drops a stale automatic match', () => {
    const tx = addTx(db, { amount: -800, at: at('2026-10-05'), merchant: 'LAZADA SG' });
    const first = ingest.ingest('', [order('lazada', 'L-7', '2026-10-05', 800)], 'import');
    expect(first).toMatchObject({ inserted: 1, updated: 0 });
    matcher.matchHousehold();
    expect(matchedTx(db, 'L-7')).toBe(tx);

    const again = ingest.ingest('', [order('lazada', 'L-7', '2026-10-05', 800)], 'import');
    expect(again).toMatchObject({ inserted: 0, updated: 1 });
    expect(matchedTx(db, 'L-7')).toBe(tx);
    expect((db.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM order_items').get() as { n: number }).n).toBe(1);

    ingest.ingest('', [order('lazada', 'L-7', '2026-10-05', 850)], 'import');
    expect(matchedTx(db, 'L-7')).toBeNull();
    matcher.matchHousehold();
    expect(matchedTx(db, 'L-7')).toBeNull();
  });

  it('exposes items, evidence for the categoriser, and status counts', () => {
    const tx = addTx(db, { amount: -2350, at: at('2026-10-05', 2), merchant: 'SHOPEE SG MP' });
    ingest.ingest('', [order('shopee', 'S-10', '2026-10-05', 2350, [
      { name: 'USB-C charging cable', qty: 2, unit_cents: 600, line_cents: 1200, url: 'https://example.com/item/1' },
      { name: 'Dish sponge pack', qty: 1, unit_cents: 1150, line_cents: 1150 },
    ]), order('shopee', 'S-11', '2026-10-25', 99)], 'import');
    matcher.matchHousehold();

    const items = matcher.itemsForTransactions([tx]).get(tx) ?? [];
    expect(items.map((item) => [item.title, item.qty, item.lineCents, item.suggestedCategory])).toEqual([
      ['USB-C charging cable', 2, 1200, 'electronics'],
      ['Dish sponge pack', 1, 1150, 'household'],
    ]);
    expect(matcher.evidenceLine(tx)).toBe(
      'order items: 2x USB-C charging cable [hint: electronics]; Dish sponge pack [hint: household]',
    );
    expect(matcher.status()).toEqual({
      total: 2,
      matched: 1,
      unmatched: 1,
      byShop: { shopee: { total: 2, matched: 1, unmatched: 1 } },
    });
  });

  it('feeds item titles to the categoriser as context without touching a labelled transaction', async () => {
    const labelled = addTx(db, { amount: -2350, at: at('2026-10-05', 2), merchant: 'SHOPEE SG MP', category: 'user-choice' });
    ingest.ingest('', [order('shopee', 'S-20', '2026-10-05', 2350, [{ name: 'Cat litter 10L', qty: 1 }])], 'import');
    matcher.matchHousehold();
    const categoriser = new CategoriserService(db, { schema: { categories: [] } as never, seedMemoryCsv: null, alwaysReview: [] });
    expect(categoriser.contextEvidence(labelled)).toContain('Cat litter 10L [hint: pets]');
    const outcome = await categoriser.categorizeTransaction(labelled);
    expect(outcome.rationale).toBe('already labelled');
    const row = db.prepare('SELECT category FROM transactions WHERE id = ?').get(labelled) as { category: string };
    expect(row.category).toBe('user-choice');
  });
});

describe('KeywordItemHinter', () => {
  it('is a conservative placeholder', () => {
    const hinter = new KeywordItemHinter();
    expect(hinter.suggest('Organic jasmine rice 5kg')).toBe('groceries');
    expect(hinter.suggest('Something entirely unclear')).toBeNull();
  });
});

describe('re-matching when a statement arrives after the order', () => {
  it('links the order during statement import, before categorisation', async () => {
    const { PipelineService } = await import('../../src/server/services/pipeline-service.js');
    const { ImportService } = await import('../../src/server/services/import-service.js');
    const { LocalDocumentStore } = await import('../../src/server/storage/document-store.js');
    const { defaultRegistry } = await import('../../src/server/adapters/registry.js');
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const db = new Database(':memory:');
    runMigrations(db, { quiet: true });
    db.exec(`INSERT INTO accounts (id, name, aliases, account_group, opened_at, created_at)
      VALUES ('acct1', 'Card', '["xxxx"]', 'credit', ${Date.now()}, ${Date.now()})`);
    const store = new LocalDocumentStore(fs.mkdtempSync(path.join(os.tmpdir(), 'oe-orders-')));
    const pipeline = new PipelineService(db, null, [{ accountHint: 'xxxx', accountAlias: 'xxxx', accountId: 'acct1' }]);
    const importer = new ImportService(db, store, defaultRegistry, pipeline);

    const day = new Date().toISOString().split('T')[0]!;
    // The generic CSV adapter books lines in USD, so the synthetic order uses USD too.
    new OrdersIngestService(db).ingest('', [{ ...order('shopee', 'S-pipe', day, 1234, [{ name: 'Synthetic phone case', qty: 1 }]), currency: 'USD' }], 'import');
    expect(matchedTx(db, 'S-pipe')).toBeNull();

    const csv = Buffer.from(`Date,Description,Amount,Account\n${day},SHOPEE SG MP SINGAPORE,-12.34,xxxx\n`);
    await importer.import('statement.csv', csv);
    const tx = db.prepare("SELECT id FROM transactions WHERE merchant_text LIKE '%SHOPEE%'").get() as { id: string };
    expect(tx).toBeDefined();
    expect(matchedTx(db, 'S-pipe')).toBe(tx.id);
    db.close();
  });
});
