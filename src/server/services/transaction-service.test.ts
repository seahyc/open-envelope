import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TransactionService } from './transaction-service';
import { initDatabase, closeDatabase } from '../db/database';
import type Database from 'better-sqlite3';
import crypto from 'crypto';

describe('TransactionService', () => {
  let db: Database.Database;
  let service: TransactionService;
  let accountId: string;

  beforeEach(() => {
    db = initDatabase(':memory:');
    service = new TransactionService(db);
    
    accountId = crypto.randomBytes(8).toString('hex');
    db.prepare(`
      INSERT INTO accounts (id, name, aliases, account_group, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(accountId, 'Test Account', JSON.stringify(['1111']), 'budget', Date.now());

    db.prepare(`
      INSERT INTO raw_documents (hash, filename, mime_type, uploaded_at, size_bytes)
      VALUES (?, ?, ?, ?, ?)
    `).run('email-doc', 'email.eml', 'message/rfc822', Date.now(), 100);

    db.prepare(`
      INSERT INTO raw_documents (hash, filename, mime_type, uploaded_at, size_bytes)
      VALUES (?, ?, ?, ?, ?)
    `).run('statement-doc', 'statement.ofx', 'application/x-ofx', Date.now(), 1000);

    db.prepare(`
      INSERT INTO raw_documents (hash, filename, mime_type, uploaded_at, size_bytes)
      VALUES (?, ?, ?, ?, ?)
    `).run('doc-1', 'doc-1.ofx', 'application/x-ofx', Date.now(), 1000);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('should match email alert with statement line', () => {
    const now = Date.now();
    const emailObsId = 'email-obs-1';
    const statementObsId = 'statement-obs-1';

    db.prepare(`
      INSERT INTO observations (
        id, document_hash, account_hint, amount_cents, currency,
        timestamp, merchant_text, kind, adapter_name, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      emailObsId,
      'email-doc',
      '1111',
      -5000,
      'USD',
      now,
      'Coffee Shop',
      'purchase',
      'email-sample',
      now
    );

    service.processObservations(accountId);

    let transactions = db.prepare('SELECT * FROM transactions').all() as Array<{
      id: string;
      state: string;
      observation_ids: string;
    }>;
    expect(transactions).toHaveLength(1);
    expect(transactions[0]?.state).toBe('pending');

    db.prepare(`
      INSERT INTO observations (
        id, document_hash, account_hint, amount_cents, currency,
        timestamp, merchant_text, kind, adapter_name, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      statementObsId,
      'statement-doc',
      '1111',
      -5000,
      'USD',
      now + 1000,
      'Coffee Shop',
      'purchase',
      'ofx',
      now + 86400000
    );

    service.processObservations(accountId);

    transactions = db.prepare('SELECT * FROM transactions').all() as Array<{
      id: string;
      state: string;
      observation_ids: string;
    }>;
    expect(transactions).toHaveLength(1);
    expect(transactions[0]?.state).toBe('posted');
    
    const obsIds = JSON.parse(transactions[0]!.observation_ids);
    expect(obsIds).toContain(emailObsId);
    expect(obsIds).toContain(statementObsId);
  });

  it('should handle FX amount changes during matching', () => {
    const now = Date.now();

    db.prepare(`
      INSERT INTO observations (
        id, document_hash, account_hint, amount_cents, currency,
        timestamp, merchant_text, kind, adapter_name, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'email-obs',
      'email-doc',
      '1111',
      -10000,
      'USD',
      now,
      'Foreign Merchant',
      'purchase',
      'email-sample',
      now
    );

    service.processObservations(accountId);

    db.prepare(`
      INSERT INTO observations (
        id, document_hash, account_hint, amount_cents, currency,
        fx_amount_cents, fx_currency, timestamp, merchant_text, kind, adapter_name, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'statement-obs',
      'statement-doc',
      '1111',
      -10000,
      'USD',
      -8500,
      'EUR',
      now + 1000,
      'Foreign Merchant',
      'purchase',
      'ofx',
      now + 86400000
    );

    service.processObservations(accountId);

    const transactions = db.prepare('SELECT * FROM transactions').all() as Array<{
      fx_amount_cents: number | null;
      fx_currency: string | null;
    }>;
    expect(transactions).toHaveLength(1);
    expect(transactions[0]?.fx_amount_cents).toBe(-8500);
    expect(transactions[0]?.fx_currency).toBe('EUR');
  });

  it('should flag unposted holds after 14 days', () => {
    const oldTimestamp = Date.now() - 15 * 24 * 60 * 60 * 1000;

    db.prepare(`
      INSERT INTO observations (
        id, document_hash, account_hint, amount_cents, currency,
        timestamp, merchant_text, kind, adapter_name, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'old-email',
      'email-doc',
      '1111',
      -3000,
      'USD',
      oldTimestamp,
      'Old Pending Charge',
      'purchase',
      'email-sample',
      oldTimestamp
    );

    service.processObservations(accountId);

    const transactions = db.prepare('SELECT * FROM transactions').all() as Array<{
      notes: string | null;
    }>;
    expect(transactions).toHaveLength(1);
    expect(transactions[0]?.notes).toBe('REVIEW: Hold never posted');

    const reviewQueue = service.getReviewQueue();
    expect(reviewQueue).toHaveLength(1);
  });

  it('should not duplicate transactions on re-import', () => {
    const now = Date.now();

    db.prepare(`
      INSERT INTO observations (
        id, document_hash, account_hint, amount_cents, currency,
        timestamp, merchant_text, kind, adapter_name, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'obs-1',
      'doc-1',
      '1111',
      -5000,
      'USD',
      now,
      'Store Name',
      'purchase',
      'ofx',
      now
    );

    service.processObservations(accountId);
    let count1 = (db.prepare('SELECT COUNT(*) as count FROM transactions').get() as { count: number }).count;

    service.processObservations(accountId);
    let count2 = (db.prepare('SELECT COUNT(*) as count FROM transactions').get() as { count: number }).count;

    expect(count1).toBe(count2);
  });
});
