import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/server/db/migrations.js';
import { BudgetService } from '../../src/server/services/budget-service.js';
import { ReconciliationService } from '../../src/server/services/reconciliation-service.js';
import { TransferService } from '../../src/server/services/transfer-service.js';
import crypto from 'crypto';

describe('LLM Guards', () => {
  let db: Database.Database;
  let budgetService: BudgetService;
  let reconciliationService: ReconciliationService;
  let transferService: TransferService;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);

    const now = Date.now();
    db.exec(`
      INSERT INTO accounts (id, name, aliases, account_group, created_at)
      VALUES ('test-account', 'Test Account', '["test"]', 'budget', ${now})
    `);

    db.exec(`
      INSERT INTO envelopes (id, name, owner, created_at)
      VALUES ('test-envelope', 'Test Envelope', 'shared', ${now})
    `);

    budgetService = new BudgetService(db);
    reconciliationService = new ReconciliationService(db);
    transferService = new TransferService(db);
  });

  it('rejects LLM-sourced budget allocations', () => {
    expect(() => {
      budgetService.allocate('test-envelope', '2024-01', 10000, 'llm');
    }).toThrow(/GUARD.*LLM-sourced.*budget allocation/i);
  });

  it('rejects LLM-fallback budget allocations', () => {
    expect(() => {
      budgetService.allocate('test-envelope', '2024-01', 10000, 'llm-fallback');
    }).toThrow(/GUARD.*LLM-sourced.*budget allocation/i);
  });

  it('allows user-sourced budget allocations', () => {
    expect(() => {
      budgetService.allocate('test-envelope', '2024-01', 10000, 'user');
    }).not.toThrow();
  });

  it('rejects LLM-sourced statement period creation', () => {
    const now = Date.now();
    expect(() => {
      reconciliationService.createStatementPeriod(
        'test-account',
        now,
        now + 86400000,
        100000,
        150000,
        undefined,
        'llm'
      );
    }).toThrow(/GUARD.*LLM-sourced.*statement_periods INSERT/i);
  });

  it('allows adapter-sourced statement period creation', () => {
    const now = Date.now();
    expect(() => {
      reconciliationService.createStatementPeriod(
        'test-account',
        now,
        now + 86400000,
        100000,
        150000,
        undefined,
        'adapter'
      );
    }).not.toThrow();
  });

  it('rejects LLM-sourced reconciliation', () => {
    const now = Date.now();
    const periodId = reconciliationService.createStatementPeriod(
      'test-account',
      now,
      now + 86400000,
      100000,
      150000,
      undefined,
      'adapter'
    );

    expect(() => {
      reconciliationService.reconcilePeriod(periodId, 'llm');
    }).toThrow(/GUARD.*LLM-sourced/i);
  });

  it('rejects LLM-sourced transfer linking', () => {
    const now = Date.now();
    const txId1 = crypto.randomBytes(8).toString('hex');
    const txId2 = crypto.randomBytes(8).toString('hex');

    db.exec(`
      INSERT INTO accounts (id, name, aliases, account_group, created_at)
      VALUES ('account2', 'Account 2', '["acc2"]', 'budget', ${now})
    `);

    db.prepare(`
      INSERT INTO transactions (id, account_id, amount_cents, currency, timestamp, merchant_text, state, observation_ids, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(txId1, 'test-account', -10000, 'SGD', now, 'Transfer Out', 'posted', JSON.stringify([]), now, now);

    db.prepare(`
      INSERT INTO transactions (id, account_id, amount_cents, currency, timestamp, merchant_text, state, observation_ids, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(txId2, 'account2', 10000, 'SGD', now, 'Transfer In', 'posted', JSON.stringify([]), now, now);

    expect(() => {
      transferService.detectAndLinkTransfers('llm');
    }).toThrow(/GUARD.*LLM-sourced.*transfer link UPDATE/i);
  });

  it('allows rule-based transfer linking', () => {
    const now = Date.now();
    const txId1 = crypto.randomBytes(8).toString('hex');
    const txId2 = crypto.randomBytes(8).toString('hex');

    db.exec(`
      INSERT INTO accounts (id, name, aliases, account_group, created_at)
      VALUES ('account2', 'Account 2', '["acc2"]', 'budget', ${now})
    `);

    db.prepare(`
      INSERT INTO transactions (id, account_id, amount_cents, currency, timestamp, merchant_text, state, observation_ids, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(txId1, 'test-account', -10000, 'SGD', now, 'Transfer Out', 'posted', JSON.stringify([]), now, now);

    db.prepare(`
      INSERT INTO transactions (id, account_id, amount_cents, currency, timestamp, merchant_text, state, observation_ids, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(txId2, 'account2', 10000, 'SGD', now, 'Transfer In', 'posted', JSON.stringify([]), now, now);

    expect(() => {
      transferService.detectAndLinkTransfers('rule');
    }).not.toThrow();
  });
});
