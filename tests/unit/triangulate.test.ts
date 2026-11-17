import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/server/db/migrations.js';
import { TriangulateService, formatClockRange } from '../../src/server/services/context/triangulate.js';
import { formatFacts } from '../../src/server/categoriser/prompt.js';

describe('triangulate matching', () => {
  let db: Database.Database;
  let service: TriangulateService;
  const previous = process.env.CONTEXT_TRIANGULATE;

  beforeEach(() => {
    process.env.CONTEXT_TRIANGULATE = '1';
    db = new Database(':memory:');
    runMigrations(db, { quiet: true });
    db.prepare(
      "INSERT INTO household_members (id, name, email, created_at) VALUES ('mem-alex', 'Alex', 'a@example.com', ?)"
    ).run(Date.now());
    db.prepare(`
      INSERT INTO accounts (id, name, aliases, account_group, created_at)
      VALUES ('acc-1', 'Visa', '[]', 'credit', ?)
    `).run(Date.now());
    service = new TriangulateService(db, () => Date.UTC(2026, 9, 14, 14, 20, 0));
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.CONTEXT_TRIANGULATE;
    else process.env.CONTEXT_TRIANGULATE = previous;
    db.close();
  });

  function insertTx(id: string, merchant: string, amount: number, ts: number): void {
    db.prepare(`
      INSERT INTO transactions (
        id, account_id, amount_cents, currency, timestamp, merchant_text,
        state, observation_ids, created_at, updated_at
      ) VALUES (?, 'acc-1', ?, 'SGD', ?, ?, 'posted', '[]', ?, ?)
    `).run(id, amount, ts, merchant, ts, ts);
  }

  it('links a Shopee charge to its order and a Jewel charge to place + calendar', () => {
    const ts = Date.UTC(2026, 9, 14, 14, 20, 0);
    insertTx('tx-shopee', 'SHOPEE *SG', -19900, ts);
    insertTx('tx-jewel', 'JEWEL CHANGI', -1850, ts);
    db.prepare(`
      INSERT INTO orders (id, merchant, order_ref, member_id, total_cents, currency, ordered_at, created_at)
      VALUES ('ord-1', 'shopee', '220101', 'mem-alex', 19900, 'SGD', ?, ?)
    `).run(Date.UTC(2026, 9, 14, 9, 0, 0), ts);
    db.prepare(`
      INSERT INTO order_items (id, order_id, name, qty, unit_cents, line_cents)
      VALUES ('it-1', 'ord-1', 'AirPods', 1, 18900, 18900),
             ('it-2', 'ord-1', 'cable', 1, 1000, 1000)
    `).run();
    db.prepare(`
      INSERT INTO place_visits (
        id, member_id, lat, lng, arrived_at, left_at, place_name, place_source, created_at
      ) VALUES ('vis-1', 'mem-alex', 1.36, 103.99, ?, ?, 'Jewel Changi', 'seed', ?)
    `).run(Date.UTC(2026, 9, 14, 14, 10, 0), Date.UTC(2026, 9, 14, 14, 40, 0), ts);
    db.prepare(`
      INSERT INTO calendar_events (id, member_id, title, location, starts_at, ends_at, fetched_at)
      VALUES ('cal-1', 'mem-alex', 'Dinner', 'Jewel Changi', ?, ?, ?)
    `).run(Date.UTC(2026, 9, 14, 14, 0, 0), Date.UTC(2026, 9, 14, 15, 30, 0), ts);

    expect(service.forTransaction('tx-shopee')).toBe(1);
    expect(service.forTransaction('tx-jewel')).toBe(2);
    const snippets = [
      ...service.snippetsFor('tx-shopee'),
      ...service.snippetsFor('tx-jewel'),
    ];
    expect(snippets.map((row) => row.snippet).sort()).toEqual([
      'Shopee order #220101: 2 items',
      'at Jewel Changi 2:10–2:40pm',
      'calendar: Dinner',
    ].sort());
    expect(snippets.find((row) => row.kind === 'order')?.memberName).toBe('Alex');

    db.prepare(`
      INSERT OR IGNORE INTO context_links (
        id, transaction_id, kind, source_id, confidence, snippet, proposed_split, status, created_at
      ) VALUES ('link-order-jewel', 'tx-jewel', 'order', 'ord-1', 0.9, 'Shopee order #220101: 2 items', ?, 'proposed', ?)
    `).run(JSON.stringify([
      { name: 'AirPods', qty: 1, lineCents: 18900 },
      { name: 'cable', qty: 1, lineCents: 1000 },
    ]), ts);
    const evidence = service.evidenceLine('tx-jewel')!;
    expect(evidence).toContain('at Jewel Changi');
    expect(evidence).toContain('Dinner');
    expect(evidence).toContain('AirPods');
    expect(evidence).not.toMatch(/1\.36|103\.99|DTSTART|calendar\.google/i);
    const facts = formatFacts({
      merchant: 'JEWEL CHANGI',
      amountCents: -1850,
      contextEvidence: evidence,
    });
    expect(facts).toContain('Context:');
    expect(facts).toContain('at Jewel Changi');
    expect(facts).toContain('Dinner');
    expect(facts).toContain('AirPods');
    expect(facts).not.toMatch(/1\.36|103\.99/);
  });

  it('matches FX-tolerant and multi-order sums, and confirm copies item names into notes', () => {
    const ts = Date.UTC(2026, 9, 14, 12, 0, 0);
    insertTx('tx-fx', 'SHOPEE *SG', -20100, ts);
    db.prepare(`
      INSERT INTO orders (id, merchant, order_ref, member_id, total_cents, currency, ordered_at, created_at)
      VALUES ('ord-a', 'shopee', 'A', 'mem-alex', 10000, 'SGD', ?, ?),
             ('ord-b', 'shopee', 'B', 'mem-alex', 10100, 'SGD', ?, ?)
    `).run(ts, ts, ts, ts);
    db.prepare(`
      INSERT INTO order_items (id, order_id, name, qty, line_cents)
      VALUES ('ia', 'ord-a', 'Case', 1, 10000), ('ib', 'ord-b', 'Cable', 1, 10100)
    `).run();
    expect(service.forTransaction('tx-fx')).toBe(2);

    insertTx('tx-one', 'LAZADA SG', -2100, ts);
    db.prepare(`
      INSERT INTO orders (id, merchant, order_ref, member_id, total_cents, currency, ordered_at, created_at)
      VALUES ('ord-lz', 'lazada', 'LZ-1', 'mem-alex', 2100, 'SGD', ?, ?)
    `).run(ts, ts);
    db.prepare(`
      INSERT INTO order_items (id, order_id, name, qty, line_cents)
      VALUES ('lz1', 'ord-lz', 'USB-C cable', 1, 1290), ('lz2', 'ord-lz', 'Phone case', 1, 810)
    `).run();
    service.forTransaction('tx-one');
    const link = db.prepare(
      "SELECT id, proposed_split FROM context_links WHERE transaction_id = 'tx-one' AND kind = 'order'"
    ).get() as { id: string; proposed_split: string };
    expect(JSON.parse(link.proposed_split)).toHaveLength(2);
    const before = db.prepare("SELECT amount_cents FROM transactions WHERE id = 'tx-one'").get() as { amount_cents: number };
    service.confirm(link.id, { split: true });
    const after = db.prepare(
      "SELECT amount_cents, notes FROM transactions WHERE id = 'tx-one'"
    ).get() as { amount_cents: number; notes: string };
    expect(after.amount_cents).toBe(before.amount_cents);
    expect(after.notes).toMatch(/USB-C cable/);
    expect(db.prepare("SELECT status FROM context_links WHERE id = ?").get(link.id)).toEqual({ status: 'confirmed' });
  });

  it('does nothing when the triangulate flag is off', () => {
    process.env.CONTEXT_TRIANGULATE = '';
    insertTx('tx-off', 'JEWEL CHANGI', -100, Date.UTC(2026, 9, 14, 14, 20, 0));
    expect(service.forTransaction('tx-off')).toBe(0);
  });

  it('formats a same-period clock range', () => {
    expect(formatClockRange(Date.UTC(2026, 9, 14, 14, 10, 0), Date.UTC(2026, 9, 14, 14, 40, 0))).toBe('2:10–2:40pm');
  });
});
