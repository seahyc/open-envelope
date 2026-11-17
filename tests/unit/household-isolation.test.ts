import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/server/db/migrations.js';
import { DEFAULT_HOUSEHOLD_ID, runWithHousehold } from '../../src/server/lib/tenancy.js';
import { OnboardingService } from '../../src/server/services/onboarding-service.js';
import { BudgetService } from '../../src/server/services/budget-service.js';
import { HomeService } from '../../src/server/services/home-service.js';
import { resolveCurrentMember } from '../../src/server/lib/member-identity.js';
import { MerchantMemory } from '../../src/server/categoriser/memory.js';
import { ReviewService } from '../../src/server/services/review-service.js';
import { CategoriserService } from '../../src/server/categoriser/service.js';

function insertAccount(db: Database.Database, householdId: string, id: string, name: string): void {
  db.prepare(`
    INSERT INTO accounts (id, household_id, name, aliases, account_group, created_at)
    VALUES (?, ?, ?, '[]', 'budget', ?)
  `).run(id, householdId, name, Date.now());
}

function insertTx(
  db: Database.Database,
  householdId: string,
  id: string,
  accountId: string,
  amount: number,
  merchant: string,
  category?: string,
): void {
  const now = Date.now();
  db.prepare(`
    INSERT INTO transactions (
      id, household_id, account_id, amount_cents, currency, timestamp, merchant_text,
      state, category, observation_ids, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'SGD', ?, ?, 'posted', ?, '[]', ?, ?)
  `).run(id, householdId, accountId, amount, now, merchant, category ?? null, now, now);
}

describe('household query isolation', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, { quiet: true });
    const now = Date.now();
    db.prepare(
      "INSERT INTO households (id, name, currency, onboarding_step, created_at, updated_at) VALUES ('hh-2', 'Other couple', 'USD', 'complete', ?, ?)"
    ).run(now, now);

    insertAccount(db, DEFAULT_HOUSEHOLD_ID, 'acc-1', 'Alex Checking');
    insertAccount(db, 'hh-2', 'acc-2', 'Other Checking');
    insertTx(db, DEFAULT_HOUSEHOLD_ID, 'tx-1', 'acc-1', 600_000, 'PAYROLL', 'income');
    insertTx(db, 'hh-2', 'tx-2', 'acc-2', 9_999_999, 'SECRET PAY', 'income');
    db.prepare(
      "INSERT INTO household_members (id, household_id, name, email, created_at) VALUES ('m-alex', 'hh-1', 'Alex', 'alex@example.test', ?)"
    ).run(now);
    db.prepare(
      "INSERT INTO household_members (id, household_id, name, email, created_at) VALUES ('m-other', 'hh-2', 'Alex', 'other@example.test', ?)"
    ).run(now);
    db.prepare(
      "INSERT INTO envelopes (id, household_id, name, owner, created_at) VALUES ('env-1', 'hh-1', 'Groceries', 'shared', ?)"
    ).run(now);
    db.prepare(
      "INSERT INTO envelopes (id, household_id, name, owner, created_at) VALUES ('env-2', 'hh-2', 'Hidden', 'shared', ?)"
    ).run(now);
    db.prepare(
      "INSERT INTO budget_allocations (id, household_id, envelope_id, month, allocated_cents, created_at) VALUES ('ba-1', 'hh-1', 'env-1', '2026-10', 10000, ?)"
    ).run(now);
    db.prepare(
      "INSERT INTO budget_allocations (id, household_id, envelope_id, month, allocated_cents, created_at) VALUES ('ba-2', 'hh-2', 'env-2', '2026-10', 888888, ?)"
    ).run(now);
  });

  it('onboarding counts only the current household', () => {
    const service = new OnboardingService(db);
    expect(service.accountCount()).toBe(1);
    expect(service.transactionCount()).toBe(1);
    expect(service.listMembers()).toEqual([{ name: 'Alex', email: 'alex@example.test' }]);

    runWithHousehold('hh-2', () => {
      expect(service.accountCount()).toBe(1);
      expect(service.transactionCount()).toBe(1);
      expect(service.listMembers()).toEqual([{ name: 'Alex', email: 'other@example.test' }]);
    });
  });

  it('budget RTA does not include the other household paycheque', () => {
    const budget = new BudgetService(db);
    const month = new Date().toISOString().slice(0, 7);
    const rta1 = budget.getReadyToAssign(month);
    const rta2 = runWithHousehold('hh-2', () => budget.getReadyToAssign(month));
    expect(rta1).toBe(600_000 - 10_000);
    expect(rta2).toBe(9_999_999 - 888_888);
  });

  it('home glance does not list the other couple accounts or pay', () => {
    const home = new HomeService(db, undefined, () => 0);
    const glance = home.glance();
    expect(glance.accounts.map((a) => a.id)).toEqual(['acc-1']);
    expect(glance.recent.map((r) => r.id)).toEqual(['tx-1']);

    const other = runWithHousehold('hh-2', () => home.glance());
    expect(other.accounts.map((a) => a.id)).toEqual(['acc-2']);
    expect(other.recent.map((r) => r.id)).toEqual(['tx-2']);
  });

  it('member identity stays inside the household', () => {
    const yc = resolveCurrentMember(db, 'alex');
    expect(yc?.email).toBe('alex@example.test');
    const other = runWithHousehold('hh-2', () => resolveCurrentMember(db, 'alex'));
    expect(other?.email).toBe('other@example.test');
  });

  it('review queue does not list the other couple', () => {
    db.prepare(`
      INSERT INTO review_queue (id, household_id, observation_id, document_hash, reason, detail, created_at)
      VALUES ('rev-1', 'hh-1', NULL, NULL, 'low_confidence_category', ?, ?)
    `).run(JSON.stringify({ transactionId: 'tx-1' }), Date.now());
    db.prepare(`
      INSERT INTO review_queue (id, household_id, observation_id, document_hash, reason, detail, created_at)
      VALUES ('rev-2', 'hh-2', NULL, NULL, 'low_confidence_category', ?, ?)
    `).run(JSON.stringify({ transactionId: 'tx-2' }), Date.now());
    const review = new ReviewService(db, new CategoriserService(db));
    expect(review.list().items.map((item) => item.id)).toEqual(['rev-1']);
    const other = runWithHousehold('hh-2', () => review.list());
    expect(other.items.map((item) => item.id)).toEqual(['rev-2']);
  });

  it('merchant memory does not leak rules across households', () => {
    const memory = new MerchantMemory(db);
    memory.add('Kopi Corner', 'food.hawker', 5);
    expect(memory.lookup('Kopi Corner')?.categoryId).toBe('food.hawker');
    const leaked = runWithHousehold('hh-2', () => memory.lookup('Kopi Corner'));
    expect(leaked).toBeNull();
  });
});
