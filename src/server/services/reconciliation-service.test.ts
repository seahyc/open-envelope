import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ReconciliationService } from './reconciliation-service';
import { initDatabase, closeDatabase } from '../db/database';
import type Database from 'better-sqlite3';
import crypto from 'crypto';

describe('ReconciliationService', () => {
  let db: Database.Database;
  let service: ReconciliationService;
  let accountId: string;

  beforeEach(() => {
    db = initDatabase(':memory:');
    service = new ReconciliationService(db);
    
    accountId = crypto.randomBytes(8).toString('hex');
    db.prepare(`
      INSERT INTO accounts (id, name, aliases, account_group, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(accountId, 'Test Account', JSON.stringify(['1111']), 'budget', Date.now());

    db.prepare(`
      INSERT INTO raw_documents (hash, filename, mime_type, uploaded_at, size_bytes)
      VALUES (?, ?, ?, ?, ?)
    `).run('stmt-doc', 'statement.pdf', 'application/pdf', Date.now(), 1000);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('should reconcile period with matching balances', () => {
    const startDate = new Date('2024-01-01').getTime();
    const endDate = new Date('2024-01-31').getTime();
    const now = new Date('2024-01-15').getTime();

    db.prepare(`
      INSERT INTO transactions (
        id, account_id, amount_cents, currency, timestamp,
        merchant_text, state, observation_ids, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomBytes(8).toString('hex'), accountId, -5000, 'USD', now,
      'Purchase', 'posted', JSON.stringify(['obs1']), now, now
    );

    db.prepare(`
      INSERT INTO transactions (
        id, account_id, amount_cents, currency, timestamp,
        merchant_text, state, observation_ids, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomBytes(8).toString('hex'), accountId, 300000, 'USD', now,
      'Salary', 'posted', JSON.stringify(['obs2']), now, now
    );

    const periodId = service.createStatementPeriod(
      accountId,
      startDate,
      endDate,
      100000,
      395000,
      'stmt-doc'
    );

    const result = service.reconcilePeriod(periodId);

    expect(result.success).toBe(true);
    expect(result.discrepancyCents).toBe(0);

    const transactions = db.prepare(
      'SELECT state FROM transactions WHERE account_id = ?'
    ).all(accountId) as Array<{ state: string }>;

    expect(transactions.every(t => t.state === 'reconciled')).toBe(true);
  });

  it('should detect reconciliation mismatch', () => {
    const startDate = new Date('2024-01-01').getTime();
    const endDate = new Date('2024-01-31').getTime();
    const now = new Date('2024-01-15').getTime();

    db.prepare(`
      INSERT INTO transactions (
        id, account_id, amount_cents, currency, timestamp,
        merchant_text, state, observation_ids, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomBytes(8).toString('hex'), accountId, -5000, 'USD', now,
      'Purchase', 'posted', JSON.stringify(['obs1']), now, now
    );

    const periodId = service.createStatementPeriod(
      accountId,
      startDate,
      endDate,
      100000,
      100000,
      'stmt-doc'
    );

    const result = service.reconcilePeriod(periodId);

    expect(result.success).toBe(false);
    expect(result.discrepancyCents).toBe(-5000);

    const period = db.prepare(
      'SELECT discrepancy_cents FROM statement_periods WHERE id = ?'
    ).get(periodId) as { discrepancy_cents: number };

    expect(period.discrepancy_cents).toBe(-5000);
  });

  it('should not change transaction state when mismatch exists', () => {
    const startDate = new Date('2024-01-01').getTime();
    const endDate = new Date('2024-01-31').getTime();
    const now = new Date('2024-01-15').getTime();

    db.prepare(`
      INSERT INTO transactions (
        id, account_id, amount_cents, currency, timestamp,
        merchant_text, state, observation_ids, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomBytes(8).toString('hex'), accountId, -5000, 'USD', now,
      'Purchase', 'posted', JSON.stringify(['obs1']), now, now
    );

    const periodId = service.createStatementPeriod(
      accountId,
      startDate,
      endDate,
      100000,
      100000
    );

    service.reconcilePeriod(periodId);

    const transactions = db.prepare(
      'SELECT state FROM transactions WHERE account_id = ?'
    ).all(accountId) as Array<{ state: string }>;

    expect(transactions.every(t => t.state === 'posted')).toBe(true);
  });

  it('should list statement periods for account', () => {
    const period1 = service.createStatementPeriod(
      accountId,
      new Date('2024-01-01').getTime(),
      new Date('2024-01-31').getTime(),
      100000,
      150000
    );

    const period2 = service.createStatementPeriod(
      accountId,
      new Date('2024-02-01').getTime(),
      new Date('2024-02-29').getTime(),
      150000,
      175000
    );

    const periods = service.getStatementPeriods(accountId);

    expect(periods).toHaveLength(2);
    expect(periods[0]?.id).toBe(period2);
    expect(periods[1]?.id).toBe(period1);
  });
});
