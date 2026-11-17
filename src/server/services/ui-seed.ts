import type Database from 'better-sqlite3';
import { normalizeMerchantKey } from '../categoriser/normalize.js';
import { OnboardingService } from './onboarding-service.js';

export const UI_SEED_NOW = Date.UTC(2026, 9, 14, 10, 0, 0);
export const UI_SEED_PAYNOW =
  'FAST PAYMENT via PayNow-UEN to ABOVE ALL ENTERP OTHR-OTHR';
export const UI_SEED_CONTRACTOR =
  'FAST PAYMENT via PayNow to LIM AH HOCK OTHR-OTHR';
export const UI_SEED_CASHIER = "CASHIER'S ORDER TO ABC HOUSING PTE LTD";
export const UI_SEED_ATM = 'ATM WITHDRAWAL 3210';

export function seedUiFixtures(
  db: Database.Database,
  options: { reviews?: boolean } = {}
): { seeded: boolean; reviews: boolean } {
  const withReviews = options.reviews !== false;
  const existing = db.prepare("SELECT 1 as ok FROM accounts WHERE id = 'uiseed-posb'").get() as
    | { ok: number }
    | undefined;

  if (!existing) {
    const onboarding = new OnboardingService(db);
    onboarding.upsertMembers([
      { name: 'Alex', email: 'alex@example.com' },
      { name: 'Sam', email: 'sam@example.com' },
    ]);

    const now = UI_SEED_NOW;
    db.prepare(`
      INSERT INTO accounts (id, name, aliases, account_group, opened_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('uiseed-posb', 'Joint POSB', JSON.stringify(['posb', '3210']), 'budget', now, now);
    db.prepare(`
      INSERT INTO accounts (id, name, aliases, account_group, opened_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('uiseed-visa', 'DBS Visa', JSON.stringify(['visa', '4421']), 'credit', now, now);

    db.prepare(`
      INSERT INTO envelopes (id, name, owner, monthly_target_cents, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('uiseed-env-groc', 'Groceries', 'shared', 80000, now);

    insertTx(db, {
      id: 'uiseed-tx-salary',
      account: 'uiseed-posb',
      amount: 520000,
      merchant: 'ACME PTE LTD PAYROLL',
      category: 'income',
      day: 1,
      state: 'reconciled',
    });
    insertTx(db, {
      id: 'uiseed-tx-fairprice',
      account: 'uiseed-posb',
      amount: -6215,
      merchant: 'FairMart',
      category: 'exp.food.groceries',
      day: 13,
      state: 'posted',
    });
  }

  seedGlanceFixtures(db);
  db.prepare('DELETE FROM payee_notes').run();

  if (withReviews) {
    db.prepare("UPDATE review_queue SET resolved = 1, resolved_at = ? WHERE id NOT LIKE 'cat-uiseed-%' AND resolved = 0").run(Date.now());
    seedReviewItems(db);
  } else {
    db.prepare('UPDATE review_queue SET resolved = 1, resolved_at = ? WHERE resolved = 0').run(Date.now());
  }

  seedContextFixtures(db);

  return { seeded: !existing, reviews: withReviews };
}

function seedGlanceFixtures(db: Database.Database): void {
  const now = UI_SEED_NOW;
  db.prepare(`
    INSERT OR IGNORE INTO accounts (id, name, aliases, account_group, opened_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('uiseed-cpf', 'CPF OA', JSON.stringify(['cpf']), 'tracking', now, now);

  insertPeriod(db, {
    id: 'uiseed-period-posb',
    account: 'uiseed-posb',
    start: Date.UTC(2026, 9, 1),
    end: Date.UTC(2026, 9, 14),
    opening: 500000,
    closing: 493785,
  });
  insertPeriod(db, {
    id: 'uiseed-period-cpf',
    account: 'uiseed-cpf',
    start: Date.UTC(2026, 8, 1),
    end: Date.UTC(2026, 8, 30),
    opening: 12800000,
    closing: 12850000,
  });

  insertTx(db, {
    id: 'uiseed-tx-mrt',
    account: 'uiseed-posb',
    amount: -1850,
    merchant: 'SimplyGo Transit',
    category: 'exp.transport.transit',
    day: 12,
    state: 'posted',
  });
  insertTx(db, {
    id: 'uiseed-tx-hawker',
    account: 'uiseed-posb',
    amount: -940,
    merchant: 'Maxwell Food Centre',
    category: 'exp.food.dining.hawker',
    day: 7,
    state: 'posted',
  });
  insertTx(db, {
    id: 'uiseed-tx-sep-fair',
    account: 'uiseed-posb',
    amount: -4000,
    merchant: 'FairMart',
    category: 'exp.food.groceries',
    day: 10,
    month: 8,
    state: 'posted',
  });
  insertTx(db, {
    id: 'uiseed-tx-sep-mrt',
    account: 'uiseed-posb',
    amount: -1200,
    merchant: 'SimplyGo Transit',
    category: 'exp.transport.transit',
    day: 12,
    month: 8,
    state: 'posted',
  });
  insertTx(db, {
    id: 'uiseed-tx-sep-hawker',
    account: 'uiseed-posb',
    amount: -800,
    merchant: 'Maxwell Food Centre',
    category: 'exp.food.dining.hawker',
    day: 18,
    month: 8,
    state: 'posted',
  });

  const payeeKey = normalizeMerchantKey(UI_SEED_PAYNOW);
  db.prepare(`
    INSERT INTO merchant_enrichments (
      merchant_key, payee_name, uen, source, registered_name, entity_status,
      ssic_code, ssic_description, registered_address, incorporation_date,
      web_description, source_urls, fetched_at
    ) VALUES (?, ?, ?, 'acra', ?, 'Live Company', ?, ?, ?, ?, NULL, ?, ?)
    ON CONFLICT(merchant_key) DO UPDATE SET
      payee_name = excluded.payee_name,
      uen = excluded.uen,
      source = excluded.source,
      registered_name = excluded.registered_name,
      entity_status = excluded.entity_status,
      ssic_code = excluded.ssic_code,
      ssic_description = excluded.ssic_description,
      registered_address = excluded.registered_address,
      incorporation_date = excluded.incorporation_date,
      source_urls = excluded.source_urls,
      fetched_at = excluded.fetched_at
  `).run(
    payeeKey,
    'ABOVE ALL ENTERP',
    '202615975E',
    'ABOVE ALL ENTERPRISE PTE. LTD.',
    '56122',
    'Food courts, coffee shops and eating houses',
    '206 Serangoon Central #04-158 S(550206)',
    '2026-04-10',
    JSON.stringify(['https://opengovsg.com/corporate/202615975E']),
    now
  );
}

function seedReviewItems(db: Database.Database): void {
  const now = UI_SEED_NOW;
  const rows: Array<{
    id: string;
    account: string;
    amount: number;
    merchant: string;
    day: number;
    hour?: number;
    minute?: number;
    categoryId: string;
    confidence: number;
    rationale: string;
  }> = [
    { id: 'uiseed-tx-kopi1', account: 'uiseed-visa', amount: -480, merchant: 'Kopi Corner', day: 14, categoryId: 'exp.food.dining.hawker', confidence: 0.62, rationale: 'Hawker lookalike' },
    { id: 'uiseed-tx-kopi2', account: 'uiseed-visa', amount: -360, merchant: 'Kopi Corner', day: 12, categoryId: 'exp.food.dining.hawker', confidence: 0.58, rationale: 'Hawker lookalike' },
    { id: 'uiseed-tx-kopi3', account: 'uiseed-visa', amount: -520, merchant: 'Kopi Corner', day: 8, categoryId: 'exp.food.dining.hawker', confidence: 0.55, rationale: 'Hawker lookalike' },
    { id: 'uiseed-tx-mart1', account: 'uiseed-posb', amount: -1890, merchant: 'FairMart', day: 11, categoryId: 'exp.food.groceries', confidence: 0.88, rationale: 'Grocer' },
    { id: 'uiseed-tx-mart2', account: 'uiseed-posb', amount: -2450, merchant: 'FairMart', day: 9, categoryId: 'exp.food.groceries', confidence: 0.81, rationale: 'Grocer' },
    { id: 'uiseed-tx-grab', account: 'uiseed-visa', amount: -1420, merchant: 'Grab Ride', day: 10, categoryId: 'exp.transport.ride', confidence: 0.64, rationale: 'Ride-hailing' },
    {
      id: 'uiseed-tx-paynow',
      account: 'uiseed-posb',
      amount: -1850,
      merchant: UI_SEED_PAYNOW,
      day: 14,
      categoryId: 'exp.food.dining.hawker',
      confidence: 0.51,
      rationale: 'S$18.50 PayNow to a cafe operator',
    },
    {
      id: 'uiseed-tx-jewel',
      account: 'uiseed-visa',
      amount: -19900,
      merchant: 'JEWEL CHANGI',
      day: 14,
      hour: 14,
      minute: 20,
      categoryId: 'exp.food.dining.hawker',
      confidence: 0.54,
      rationale: 'Mall descriptor',
    },
    {
      id: 'uiseed-tx-contractor',
      account: 'uiseed-posb',
      amount: -350000,
      merchant: UI_SEED_CONTRACTOR,
      day: 7,
      categoryId: 'exp.housing.utilities',
      confidence: 0.41,
      rationale: 'Opaque PayNow payee',
    },
    {
      id: 'uiseed-tx-atm',
      account: 'uiseed-posb',
      amount: -20000,
      merchant: UI_SEED_ATM,
      day: 6,
      categoryId: 'exp.food.dining.hawker',
      confidence: 0.22,
      rationale: 'ATM cash',
    },
    {
      id: 'uiseed-tx-cashier',
      account: 'uiseed-posb',
      amount: -50000000,
      merchant: UI_SEED_CASHIER,
      day: 3,
      categoryId: 'xfer.own',
      confidence: 0.18,
      rationale: 'One-off cashier\'s order',
    },
  ];

  for (const row of rows) {
    insertTx(db, {
      id: row.id,
      account: row.account,
      amount: row.amount,
      merchant: row.merchant,
      category: null,
      day: row.day,
      hour: row.hour,
      minute: row.minute,
      state: 'posted',
    });
    db.prepare('UPDATE transactions SET category = NULL, updated_at = ? WHERE id = ?').run(now, row.id);
    const detail = JSON.stringify({
      transactionId: row.id,
      categoryId: row.categoryId,
      confidence: row.confidence,
      rationale: row.rationale,
    });
    db.prepare(`
      INSERT INTO review_queue (id, observation_id, document_hash, reason, detail, created_at, resolved, resolved_at)
      VALUES (?, NULL, NULL, 'low_confidence_category', ?, ?, 0, NULL)
      ON CONFLICT(id) DO UPDATE SET
        detail = excluded.detail,
        reason = excluded.reason,
        resolved = 0,
        resolved_at = NULL
    `).run(`cat-${row.id}`, detail, now);
  }
}

function seedContextFixtures(db: Database.Database): void {
  const alex = db.prepare(
    "SELECT id FROM household_members WHERE lower(name) = 'alex'"
  ).get() as { id: string } | undefined;
  if (!alex) return;

  insertTx(db, {
    id: 'uiseed-tx-jewel',
    account: 'uiseed-visa',
    amount: -19900,
    merchant: 'JEWEL CHANGI',
    category: null,
    day: 14,
    hour: 14,
    minute: 20,
    state: 'posted',
  });

  const arrived = Date.UTC(2026, 9, 14, 14, 10, 0);
  const left = Date.UTC(2026, 9, 14, 14, 40, 0);
  db.prepare(`
    INSERT OR IGNORE INTO place_visits (
      id, member_id, lat, lng, arrived_at, left_at, place_name, place_source, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('uiseed-visit-jewel', alex.id, 1.3603, 103.9896, arrived, left, 'Jewel Changi', 'seed', UI_SEED_NOW);

  db.prepare(`
    INSERT OR IGNORE INTO calendar_events (
      id, member_id, title, location, starts_at, ends_at, fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    `${alex.id}:dinner-jewel`,
    alex.id,
    'Dinner',
    'Jewel Changi',
    Date.UTC(2026, 9, 14, 14, 0, 0),
    Date.UTC(2026, 9, 14, 15, 30, 0),
    UI_SEED_NOW
  );

  db.prepare(`
    INSERT OR IGNORE INTO orders (
      id, merchant, order_ref, member_id, total_cents, currency, ordered_at, source_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'uiseed-order-shopee',
    'shopee',
    '220101',
    alex.id,
    19900,
    'SGD',
    Date.UTC(2026, 9, 14, 9, 0, 0),
    'uiseed-shopee-hash',
    UI_SEED_NOW
  );
  db.prepare('DELETE FROM order_items WHERE order_id = ?').run('uiseed-order-shopee');
  db.prepare(`
    INSERT INTO order_items (id, order_id, name, qty, unit_cents, line_cents)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('uiseed-item-airpods', 'uiseed-order-shopee', 'AirPods', 1, 18900, 18900);
  db.prepare(`
    INSERT INTO order_items (id, order_id, name, qty, unit_cents, line_cents)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('uiseed-item-cable', 'uiseed-order-shopee', 'cable', 1, 1000, 1000);

  const split = JSON.stringify([
    { name: 'AirPods', qty: 1, lineCents: 18900 },
    { name: 'cable', qty: 1, lineCents: 1000 },
  ]);
  db.prepare(`
    INSERT OR IGNORE INTO context_links (
      id, transaction_id, kind, source_id, confidence, snippet, proposed_split, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?)
  `).run(
    'uiseed-link-place',
    'uiseed-tx-jewel',
    'place',
    'uiseed-visit-jewel',
    0.86,
    'at Jewel Changi 2:10–2:40pm',
    null,
    UI_SEED_NOW
  );
  db.prepare(`
    INSERT OR IGNORE INTO context_links (
      id, transaction_id, kind, source_id, confidence, snippet, proposed_split, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?)
  `).run(
    'uiseed-link-order',
    'uiseed-tx-jewel',
    'order',
    'uiseed-order-shopee',
    0.9,
    'Shopee order #220101: 2 items',
    split,
    UI_SEED_NOW
  );
  db.prepare(`
    INSERT OR IGNORE INTO context_links (
      id, transaction_id, kind, source_id, confidence, snippet, proposed_split, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?)
  `).run(
    'uiseed-link-cal',
    'uiseed-tx-jewel',
    'calendar',
    `${alex.id}:dinner-jewel`,
    0.7,
    'calendar: Dinner',
    null,
    UI_SEED_NOW
  );
  db.prepare(`
    INSERT OR IGNORE INTO spent_attributions (transaction_id, member_id, source, status)
    VALUES (?, ?, 'order', 'proposed')
  `).run('uiseed-tx-jewel', alex.id);
}

function insertPeriod(
  db: Database.Database,
  period: {
    id: string;
    account: string;
    start: number;
    end: number;
    opening: number;
    closing: number;
  }
): void {
  db.prepare(`
    INSERT OR IGNORE INTO statement_periods (
      id, account_id, start_date, end_date,
      opening_balance_cents, closing_balance_cents,
      status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'balanced', ?)
  `).run(period.id, period.account, period.start, period.end, period.opening, period.closing, UI_SEED_NOW);
}

function insertTx(
  db: Database.Database,
  tx: {
    id: string;
    account: string;
    amount: number;
    merchant: string;
    category: string | null;
    day: number;
    month?: number;
    hour?: number;
    minute?: number;
    state: string;
  }
): void {
  const ts = Date.UTC(2026, tx.month ?? 9, tx.day, tx.hour ?? 10, tx.minute ?? 0, 0);
  db.prepare(`
    INSERT OR IGNORE INTO transactions (
      id, account_id, amount_cents, currency, timestamp, merchant_text,
      state, category, observation_ids, created_at, updated_at
    ) VALUES (?, ?, ?, 'SGD', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tx.id,
    tx.account,
    tx.amount,
    ts,
    tx.merchant,
    tx.state,
    tx.category,
    JSON.stringify([]),
    UI_SEED_NOW,
    UI_SEED_NOW
  );
}
