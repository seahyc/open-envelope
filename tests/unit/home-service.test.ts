import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { join } from 'path';
import { runMigrations } from '../../src/server/db/migrations.js';
import { HomeService, LAST_MONTH_COMPARE_MIN_DAYS } from '../../src/server/services/home-service.js';
import { BudgetService } from '../../src/server/services/budget-service.js';
import { loadCategorySchema } from '../../src/server/categoriser/schema.js';
import { seedUiFixtures, UI_SEED_NOW } from '../../src/server/services/ui-seed.js';

const schema = loadCategorySchema(join(process.cwd(), 'config/categories.default.json'));
const AS_OF = Date.UTC(2026, 9, 28, 12, 0, 0);

describe('HomeService glance', () => {
  let db: Database.Database;
  let home: HomeService;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, { quiet: true });
    const budget = new BudgetService(db);
    home = new HomeService(db, schema, (month) => budget.getReadyToAssign(month));
  });

  it('returns empty glance sections without inventing balances', () => {
    const glance = home.glance(AS_OF);
    expect(glance.budget.exists).toBe(false);
    expect(glance.budget.readyToAssignCents).toBeNull();
    expect(glance.spent.thisMonthCents).toBe(0);
    expect(glance.topCategories).toEqual([]);
    expect(glance.accounts).toEqual([]);
    expect(glance.netWorth).toEqual({ cents: 0, knownAccountCount: 0, missingAccountCount: 0 });
    expect(glance.recent).toEqual([]);
  });

  it('hides ready-to-assign when no budget allocations exist and never invents S$0.00', () => {
    seedUiFixtures(db, { reviews: true });
    const glance = home.glance(AS_OF);
    expect(glance.budget.exists).toBe(false);
    expect(glance.budget.readyToAssignCents).toBeNull();
    const income = db.prepare(
      "SELECT amount_cents FROM transactions WHERE id = 'uiseed-tx-salary'"
    ).get() as { amount_cents: number };
    expect(income.amount_cents).toBe(520000);
  });

  it('returns ready-to-assign only after a budget exists', () => {
    seedUiFixtures(db, { reviews: false });
    db.prepare(`
      INSERT INTO budget_allocations (id, envelope_id, month, allocated_cents, created_at)
      VALUES ('uiseed-alloc', 'uiseed-env-groc', '2026-10', 10000, ?)
    `).run(UI_SEED_NOW);
    const glance = home.glance(AS_OF);
    expect(glance.budget.exists).toBe(true);
    expect(glance.budget.readyToAssignCents).toBe(510000);
  });

  it('compares month-to-date spend against the same day last month and buckets L2 categories', () => {
    seedUiFixtures(db, { reviews: true });
    const glance = home.glance(AS_OF);
    expect(glance.spent.thisMonthCents).toBeGreaterThan(glance.spent.lastMonthSameDayCents);
    expect(glance.spent.deltaCents).toBeGreaterThan(0);
    expect(glance.topCategories.map((row) => row.label)).toEqual([
      'Food ▸ Groceries',
      'Transport ▸ Transit',
      'Food ▸ Dining',
    ]);
  });

  it('sums known balances only and flags accounts that need a starting balance', () => {
    seedUiFixtures(db, { reviews: true });
    const glance = home.glance(AS_OF);
    const visa = glance.accounts.find((row) => row.id === 'uiseed-visa');
    const posb = glance.accounts.find((row) => row.id === 'uiseed-posb');
    const cpf = glance.accounts.find((row) => row.id === 'uiseed-cpf');
    expect(visa?.needsStartingBalance).toBe(true);
    expect(visa?.balanceCents).toBeNull();
    expect(posb?.balanceCents).toBe(493785);
    expect(cpf?.balanceCents).toBe(12850000);
    expect(glance.netWorth.cents).toBe(493785 + 12850000);
    expect(glance.netWorth.missingAccountCount).toBe(1);
    expect(glance.recent).toHaveLength(5);
  });

  it('shows raw outflow when nothing is categorised and hides last-month delta without data', () => {
    db.prepare(`
      INSERT INTO accounts (id, name, aliases, account_group, created_at)
      VALUES ('acc-raw', 'Joint POSB', '[]', 'budget', ?)
    `).run(UI_SEED_NOW);
    const ts = Date.UTC(2026, 9, 14, 10, 0, 0);
    db.prepare(`
      INSERT INTO transactions (
        id, account_id, amount_cents, currency, timestamp, merchant_text,
        state, category, observation_ids, created_at, updated_at
      ) VALUES ('tx-raw', 'acc-raw', -1850, 'SGD', ?, ?, 'posted', NULL, '[]', ?, ?)
    `).run(ts, 'FAST PAYMENT via PayNow-UEN to ABOVE ALL ENTERP OTHR-OTHR', ts, ts);
    const glance = home.glance(AS_OF);
    expect(glance.spent.categorisedCents).toBe(0);
    expect(glance.spent.thisMonthCents).toBe(1850);
    expect(glance.spent.hasLastMonthData).toBe(false);
    expect(glance.topCategories).toEqual([]);
    expect(glance.recent[0]?.merchant).toBe('Above All Enterp');
    expect(glance.latestDataAt).toBe(ts);
  });

  it('excludes cashier-sized capital from month-to-date spend and notes lagging data', () => {
    seedUiFixtures(db, { reviews: true });
    const glance = home.glance(AS_OF);
    expect(glance.spent.thisMonthCents).toBe(407875);
    expect(glance.spent.hasLastMonthData).toBe(false);
    expect(glance.spent.deltaCents).toBe(407875 - 6000);
    expect(glance.latestDataAt).toBe(Date.UTC(2026, 9, 14, 14, 20, 0));
    expect(glance.recent.some((row) => /FAST PAYMENT|OTHR-OTHR/i.test(row.merchant))).toBe(false);
    expect(glance.recent.some((row) => row.merchant === 'Above All Enterprise')).toBe(true);
  });

  it('uses the Singapore calendar for month-to-date spend', () => {
    db.prepare(`
      INSERT INTO accounts (id, name, aliases, account_group, created_at)
      VALUES ('acc-sgt', 'Joint POSB', '[]', 'budget', ?)
    `).run(Date.now());
    const earlySgtOctober = Date.UTC(2026, 8, 30, 20, 0, 0);
    db.prepare(`
      INSERT INTO transactions (
        id, account_id, amount_cents, currency, timestamp, merchant_text,
        state, category, observation_ids, created_at, updated_at
      ) VALUES ('tx-sgt-oct', 'acc-sgt', -1000, 'SGD', ?, 'Grab Ride', 'posted', NULL, '[]', ?, ?)
    `).run(earlySgtOctober, earlySgtOctober, earlySgtOctober);
    const asOf = Date.UTC(2026, 9, 1, 2, 0, 0);
    const glance = home.glance(asOf);
    expect(glance.spent.thisMonthCents).toBe(1000);
  });

  it('shows the last-month comparison only with about a week of last-month outflow days', () => {
    seedUiFixtures(db, { reviews: false });
    expect(home.glance(AS_OF).spent.hasLastMonthData).toBe(false);
    for (let day = 1; day <= LAST_MONTH_COMPARE_MIN_DAYS; day++) {
      const ts = Date.UTC(2026, 8, day, 10, 0, 0);
      db.prepare(`
        INSERT INTO transactions (
          id, account_id, amount_cents, currency, timestamp, merchant_text,
          state, category, observation_ids, created_at, updated_at
        ) VALUES (?, 'uiseed-posb', -100, 'SGD', ?, 'Kopi Corner', 'posted', 'exp.food.dining.hawker', '[]', ?, ?)
      `).run(`tx-sep-day-${day}`, ts, ts, ts);
    }
    expect(home.glance(AS_OF).spent.hasLastMonthData).toBe(true);
  });

  it('treats card outstanding as a liability without inventing a missing card balance', () => {
    seedUiFixtures(db, { reviews: false });
    db.prepare(`
      INSERT INTO statement_periods (
        id, account_id, start_date, end_date,
        opening_balance_cents, closing_balance_cents, status, created_at
      ) VALUES ('uiseed-period-visa', 'uiseed-visa', ?, ?, 0, ?, 'balanced', ?)
    `).run(Date.UTC(2026, 8, 15), Date.UTC(2026, 9, 14), -120000, UI_SEED_NOW);
    const glance = home.glance(AS_OF);
    expect(glance.netWorth.cents).toBe(493785 + 12850000 - 120000);
    expect(glance.accounts.find((row) => row.id === 'uiseed-visa')?.needsStartingBalance).toBe(false);
  });
});
