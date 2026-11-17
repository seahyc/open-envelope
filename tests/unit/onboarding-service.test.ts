import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/server/db/migrations.js';
import { OnboardingService } from '../../src/server/services/onboarding-service.js';

function insertImportedAccount(db: Database.Database, id: string, name: string, aliases: string[]): void {
  db.prepare(`
    INSERT INTO accounts (id, name, aliases, account_group, created_at)
    VALUES (?, ?, ?, 'budget', ?)
  `).run(id, name, JSON.stringify(aliases), Date.now());
}

function insertImportedTx(db: Database.Database, id: string, accountId: string, merchant: string): void {
  const now = Date.now();
  db.prepare(`
    INSERT INTO transactions (
      id, account_id, amount_cents, currency, timestamp, merchant_text,
      state, observation_ids, created_at, updated_at
    ) VALUES (?, ?, ?, 'SGD', ?, ?, 'posted', ?, ?, ?)
  `).run(id, accountId, -1250, now, merchant, JSON.stringify([]), now, now);
}

describe('OnboardingService existing household', () => {
  let db: Database.Database;
  let service: OnboardingService;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, { quiet: true });
    service = new OnboardingService(db);
  });

  it('treats a household with imported accounts and transactions as onboarded', () => {
    expect(service.isOnboarded()).toBe(false);
    insertImportedAccount(db, 'stmt-posb', 'POSB Savings', ['3210', 'posb']);
    insertImportedTx(db, 'tx-1', 'stmt-posb', 'FAIRPRICE');
    expect(service.isOnboarded()).toBe(true);
    expect(service.getStatus()).toMatchObject({
      onboarded: true,
      hasAccounts: true,
      hasTransactions: true,
      members: [],
    });
  });

  it('records member names idempotently and never creates colliding statement accounts', async () => {
    insertImportedAccount(db, 'stmt-posb', 'POSB Savings', ['3210', 'posb']);
    insertImportedTx(db, 'tx-1', 'stmt-posb', 'FAIRPRICE');
    insertImportedAccount(db, 'stmt-ocbc', 'OCBC 365', ['ocbc']);

    const beforeAccounts = db.prepare('SELECT id, name FROM accounts ORDER BY name').all();
    const beforeTxs = db.prepare('SELECT COUNT(*) as count FROM transactions').get() as { count: number };

    const first = await service.setupHousehold(
      [
        { name: 'Alex', email: 'alex@example.com' },
        { name: 'Sam', email: 'sam@example.com' },
      ],
      [
        {
          name: 'POSB Savings',
          aliases: ['3210'],
          group: 'budget',
          startingBalanceCents: 10000,
          startDate: Date.now(),
        },
        {
          name: 'Joint Checking',
          aliases: ['checking'],
          group: 'budget',
          startingBalanceCents: 500000,
          startDate: Date.now(),
        },
      ]
    );

    expect(first.membersOnly).toBe(true);
    expect(db.prepare('SELECT id, name FROM accounts ORDER BY name').all()).toEqual(beforeAccounts);
    expect((db.prepare('SELECT COUNT(*) as count FROM transactions').get() as { count: number }).count).toBe(beforeTxs.count);
    expect(service.listMembers()).toEqual([
      { name: 'Alex', email: 'alex@example.com' },
      { name: 'Sam', email: 'sam@example.com' },
    ]);
    expect(db.prepare('SELECT COUNT(*) as count FROM envelopes').get()).toEqual({ count: 0 });

    const second = await service.setupHousehold(
      [
        { name: 'alex', email: 'alex.updated@example.com' },
        { name: 'Sam', email: 'sam@example.com' },
      ],
      [
        {
          name: 'Brand New Account',
          aliases: ['9999'],
          group: 'budget',
          startingBalanceCents: 1,
          startDate: Date.now(),
        },
      ]
    );

    expect(second.membersOnly).toBe(true);
    expect(db.prepare('SELECT COUNT(*) as count FROM household_members').get()).toEqual({ count: 2 });
    expect(service.listMembers()).toEqual([
      { name: 'Alex', email: 'alex.updated@example.com' },
      { name: 'Sam', email: 'sam@example.com' },
    ]);
    expect(db.prepare('SELECT id, name FROM accounts ORDER BY name').all()).toEqual(beforeAccounts);
  });

  it('still creates accounts for a brand-new household', async () => {
    const result = await service.setupHousehold(
      [{ name: 'Alex', email: 'alex@example.com' }, { name: 'Sam', email: 'sam@example.com' }],
      [
        {
          name: 'Joint Checking',
          aliases: ['checking'],
          group: 'budget',
          startingBalanceCents: 500000,
          startDate: new Date('2024-01-01').getTime(),
        },
      ]
    );

    expect(result.membersOnly).toBe(false);
    expect(service.isOnboarded()).toBe(true);
    expect(service.accountCount()).toBe(1);
    expect(service.memberCount()).toBe(2);
    expect(db.prepare('SELECT COUNT(*) as count FROM envelopes').get()).toEqual({ count: 7 });
  });
});
