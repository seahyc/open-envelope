import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { PipelineService } from '../../src/server/services/pipeline-service.js';
import { runMigrations } from '../../src/server/db/migrations.js';

describe('Alert Deduplication', () => {
  let db: Database.Database;
  let pipelineService: PipelineService;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);

    db.exec(`
      INSERT INTO accounts (id, name, aliases, account_group, created_at)
      VALUES ('test-account', 'Test Account', '["card-1234"]', 'credit', ${Date.now()})
    `);

    pipelineService = new PipelineService(db, null, [
      { accountHint: 'card-1234', accountAlias: 'card-1234', accountId: 'test-account' }
    ]);
  });

  it('keeps genuine repeat purchases as separate transactions', async () => {
    const baseTime = new Date('2024-01-15T10:00:00Z').getTime();
    const laterTime = new Date('2024-01-15T10:15:00Z').getTime();

    db.prepare(`
      INSERT INTO raw_documents (hash, filename, mime_type, uploaded_at, size_bytes)
      VALUES ('doc1', 'alert1.eml', 'message/rfc822', ${Date.now()}, 1000)
    `).run();

    const obs1Id = 'obs1-repeat';
    db.prepare(`
      INSERT INTO observations (id, document_hash, account_hint, amount_cents, currency, timestamp, merchant_text, kind, adapter_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(obs1Id, 'doc1', 'card-1234', -1000, 'SGD', baseTime, 'COFFEE SHOP', 'purchase', 'dbs-alert', Date.now());

    await pipelineService.processDocument('doc1');

    db.prepare(`
      INSERT INTO raw_documents (hash, filename, mime_type, uploaded_at, size_bytes)
      VALUES ('doc2', 'alert2.eml', 'message/rfc822', ${Date.now()}, 1000)
    `).run();

    const obs2Id = 'obs2-repeat';
    db.prepare(`
      INSERT INTO observations (id, document_hash, account_hint, amount_cents, currency, timestamp, merchant_text, kind, adapter_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(obs2Id, 'doc2', 'card-1234', -1000, 'SGD', laterTime, 'COFFEE SHOP', 'purchase', 'dbs-alert', Date.now());

    await pipelineService.processDocument('doc2');

    const transactions = db.prepare('SELECT * FROM transactions WHERE account_id = ?').all('test-account') as any[];
    
    expect(transactions.length).toBe(2);
    expect(transactions[0]!.amount_cents).toBe(-1000);
    expect(transactions[1]!.amount_cents).toBe(-1000);
    expect(transactions[0]!.timestamp).toBe(baseTime);
    expect(transactions[1]!.timestamp).toBe(laterTime);
  });

  it('deduplicates identical alerts (same timestamp and all fields)', async () => {
    const timestamp = new Date('2024-01-15T10:00:00Z').getTime();

    db.prepare(`
      INSERT INTO raw_documents (hash, filename, mime_type, uploaded_at, size_bytes)
      VALUES ('doc3', 'alert3.eml', 'message/rfc822', ${Date.now()}, 1000)
    `).run();

    const obs1Id = 'obs1-identical';
    db.prepare(`
      INSERT INTO observations (id, document_hash, account_hint, amount_cents, currency, timestamp, merchant_text, kind, adapter_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(obs1Id, 'doc3', 'card-1234', -1000, 'SGD', timestamp, 'COFFEE SHOP', 'purchase', 'dbs-alert', Date.now());

    await pipelineService.processDocument('doc3');

    db.prepare(`
      INSERT INTO raw_documents (hash, filename, mime_type, uploaded_at, size_bytes)
      VALUES ('doc4', 'alert4.eml', 'message/rfc822', ${Date.now()}, 1000)
    `).run();

    const obs2Id = 'obs2-identical';
    db.prepare(`
      INSERT INTO observations (id, document_hash, account_hint, amount_cents, currency, timestamp, merchant_text, kind, adapter_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(obs2Id, 'doc4', 'card-1234', -1000, 'SGD', timestamp, 'COFFEE SHOP', 'purchase', 'dbs-alert', Date.now());

    await pipelineService.processDocument('doc2');

    const transactions = db.prepare('SELECT * FROM transactions WHERE account_id = ?').all('test-account') as any[];
    
    expect(transactions.length).toBe(1);
    expect(transactions[0]!.amount_cents).toBe(-1000);
  });
});
