import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/server/db/migrations.js';
import { DEFAULT_HOUSEHOLD_ID, TENANT_TABLES } from '../../src/server/lib/tenancy.js';
import { BudgetService } from '../../src/server/services/budget-service.js';

const LINE_COUNT = 1018;

function checksum(db: Database.Database) {
  const tx = db.prepare('SELECT COUNT(*) as n FROM transactions').get() as { n: number };
  const stmtObs = db.prepare(
    'SELECT COUNT(*) as n FROM observations WHERE is_statement = 1'
  ).get() as { n: number };
  const periods = db.prepare(
    `SELECT id, status, discrepancy_cents, opening_balance_cents, closing_balance_cents
     FROM statement_periods ORDER BY id`
  ).all();
  const hashes = db.prepare('SELECT hash FROM raw_documents ORDER BY hash').all();
  const amounts = db.prepare(
    'SELECT id, amount_cents, currency, state FROM transactions ORDER BY id'
  ).all();
  const income = db.prepare(`
    SELECT COALESCE(SUM(amount_cents), 0) as total FROM transactions
    WHERE strftime('%Y-%m', datetime(timestamp / 1000, 'unixepoch')) = '2024-03'
      AND amount_cents > 0 AND category = 'income'
  `).get() as { total: number };
  return {
    tx: tx.n,
    stmtObs: stmtObs.n,
    periods,
    hashes,
    amounts,
    income: income.total,
  };
}

function seed1018(db: Database.Database): void {
  const now = Date.now();
  db.prepare(`
    INSERT INTO accounts (id, name, aliases, account_group, created_at)
    VALUES ('acct-1018', 'Synthetic Checking', '[]', 'budget', ?)
  `).run(now);
  db.prepare(`
    INSERT INTO raw_documents (hash, filename, mime_type, uploaded_at, size_bytes)
    VALUES ('doc-1018', 'synthetic-1018.csv', 'text/csv', ?, 64)
  `).run(now);

  const insertObs = db.prepare(`
    INSERT INTO observations (
      id, document_hash, account_hint, amount_cents, currency, timestamp,
      merchant_text, kind, adapter_name, is_statement, created_at
    ) VALUES (?, 'doc-1018', 'synthetic-checking', ?, 'SGD', ?, ?, 'debit', 'csv-generic', 1, ?)
  `);
  const insertTx = db.prepare(`
    INSERT INTO transactions (
      id, account_id, amount_cents, currency, timestamp, merchant_text,
      state, observation_ids, created_at, updated_at
    ) VALUES (?, 'acct-1018', ?, 'SGD', ?, ?, 'posted', ?, ?, ?)
  `);

  const opening = 1_000_000;
  let running = opening;
  const start = Date.UTC(2024, 2, 1);
  for (let i = 0; i < LINE_COUNT; i++) {
    const amount = i === 0 ? 250_000 : -100 - (i % 17);
    if (i === 0) {
      db.prepare(`
        UPDATE observations SET kind = 'credit' WHERE id = ?
      `);
    }
    running += amount;
    const ts = start + i * 60_000;
    const obsId = `obs-${String(i).padStart(4, '0')}`;
    const txId = `tx-${String(i).padStart(4, '0')}`;
    const merchant = i === 0 ? 'PAYROLL' : `SYNTHETIC ${i}`;
    insertObs.run(obsId, amount, ts, merchant, now);
    insertTx.run(txId, amount, ts, merchant, JSON.stringify([obsId]), now, now);
    if (i === 0) {
      db.prepare("UPDATE transactions SET category = 'income' WHERE id = ?").run(txId);
    }
  }

  db.prepare(`
    INSERT INTO statement_periods (
      id, account_id, start_date, end_date, opening_balance_cents, closing_balance_cents,
      document_hash, discrepancy_cents, status, created_at
    ) VALUES ('period-1018', 'acct-1018', ?, ?, ?, ?, 'doc-1018', 0, 'balanced', ?)
  `).run(start, start + LINE_COUNT * 60_000, opening, running, now);

  db.prepare(`
    INSERT INTO household_members (id, name, email, created_at)
    VALUES ('mem-alex', 'Alex', 'alex@example.test', ?)
  `).run(now);
}

describe('v13 household tenancy migration', () => {
  it('stamps existing rows as hh-1 with zero data change (1018/1018 still balanced)', () => {
    const db = new Database(':memory:');
    runMigrations(db, { quiet: true, throughVersion: 12 });

    expect(
      (db.prepare("SELECT 1 as ok FROM sqlite_master WHERE name = 'households'").get() as { ok?: number } | undefined)
        ?.ok
    ).toBeUndefined();

    seed1018(db);
    const before = checksum(db);
    expect(before.tx).toBe(LINE_COUNT);
    expect(before.stmtObs).toBe(LINE_COUNT);
    expect(before.periods).toEqual([
      expect.objectContaining({
        id: 'period-1018',
        status: 'balanced',
        discrepancy_cents: 0,
      }),
    ]);

    runMigrations(db, { quiet: true });

    const version = db.prepare('SELECT MAX(version) as v FROM schema_migrations').get() as { v: number };
    expect(version.v).toBeGreaterThanOrEqual(13);

    const household = db.prepare('SELECT * FROM households WHERE id = ?').get(DEFAULT_HOUSEHOLD_ID) as {
      id: string;
      name: string;
      currency: string;
      onboarding_step: string;
    };
    expect(household).toMatchObject({
      id: DEFAULT_HOUSEHOLD_ID,
      name: 'Household',
      currency: 'SGD',
      onboarding_step: 'complete',
    });

    const after = checksum(db);
    expect(after).toEqual(before);
    expect(new BudgetService(db).getReadyToAssign('2024-03')).toBe(before.income);

    for (const table of TENANT_TABLES) {
      const exists = db.prepare(
        "SELECT 1 as ok FROM sqlite_master WHERE type = 'table' AND name = ?"
      ).get(table) as { ok: number } | undefined;
      if (!exists) continue;
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      expect(cols.some((c) => c.name === 'household_id'), table).toBe(true);
      const leaked = db.prepare(
        `SELECT COUNT(*) as n FROM ${table} WHERE household_id != ?`
      ).get(DEFAULT_HOUSEHOLD_ID) as { n: number };
      expect(leaked.n, table).toBe(0);
    }

    const balanced = db.prepare(
      "SELECT COUNT(*) as n FROM statement_periods WHERE status = 'balanced'"
    ).get() as { n: number };
    const unbalanced = db.prepare(
      "SELECT COUNT(*) as n FROM statement_periods WHERE status != 'balanced'"
    ).get() as { n: number };
    expect(balanced.n).toBe(1);
    expect(unbalanced.n).toBe(0);

    db.close();
  });

  it('lets a second household reuse the name Alex', () => {
    const db = new Database(':memory:');
    runMigrations(db, { quiet: true });
    const now = Date.now();
    db.prepare(
      "INSERT INTO households (id, name, currency, onboarding_step, created_at, updated_at) VALUES ('hh-2', 'Garden', 'SGD', 'welcome', ?, ?)"
    ).run(now, now);
    db.prepare(
      "INSERT INTO household_members (id, household_id, name, email, created_at) VALUES ('m1', 'hh-1', 'Alex', 'a@example.test', ?)"
    ).run(now);
    db.prepare(
      "INSERT INTO household_members (id, household_id, name, email, created_at) VALUES ('m2', 'hh-2', 'Alex', 'b@example.test', ?)"
    ).run(now);
    const names = db.prepare('SELECT household_id, name FROM household_members ORDER BY household_id').all();
    expect(names).toEqual([
      { household_id: 'hh-1', name: 'Alex' },
      { household_id: 'hh-2', name: 'Alex' },
    ]);
    db.close();
  });
});
