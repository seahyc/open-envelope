import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { initDatabase } from '../../src/server/db/database.js';
import { LocalDocumentStore } from '../../src/server/storage/document-store.js';
import { PipelineService } from '../../src/server/services/pipeline-service.js';
import { defaultRegistry } from '../../src/server/adapters/registry.js';

describe('Duplicate Alert Deduplication', () => {
  let tmpDir: string;
  let dbPath: string;
  let documentsDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'duplicate-test-'));
    dbPath = join(tmpDir, 'test.db');
    documentsDir = join(tmpDir, 'documents');
    mkdirSync(documentsDir, { recursive: true });
    db = initDatabase(dbPath);

    db.prepare(`
      INSERT INTO accounts (id, name, aliases, account_group, created_at)
      VALUES ('acc1', 'Test Account', '["1234"]', 'budget', ?)
    `).run(Date.now());
  });

  afterEach(() => {
    db.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('deduplicates alerts with identical timestamp and fields', async () => {
    const documentStore = new LocalDocumentStore(documentsDir);
    const pipelineService = new PipelineService(db, null, [], documentStore);

    const now = Date.now();

    db.prepare('INSERT INTO raw_documents (hash, filename, mime_type, uploaded_at, size_bytes) VALUES (?, ?, ?, ?, ?)').run('hash1', 'alert1.eml', 'message/rfc822', now, 100);
    db.prepare('INSERT INTO observations (id, document_hash, account_hint, amount_cents, currency, timestamp, merchant_text, kind, adapter_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('obs1', 'hash1', '1234', -5000, 'SGD', now, 'FAIRPRICE', 'purchase', 'dbs-alert', now);

    const result1 = await pipelineService.processDocument('hash1');
    expect(result1.transactionsCreated).toBe(1);

    db.prepare('INSERT INTO raw_documents (hash, filename, mime_type, uploaded_at, size_bytes) VALUES (?, ?, ?, ?, ?)').run('hash2', 'alert2.eml', 'message/rfc822', now, 100);
    db.prepare('INSERT INTO observations (id, document_hash, account_hint, amount_cents, currency, timestamp, merchant_text, kind, adapter_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('obs2', 'hash2', '1234', -5000, 'SGD', now, 'FAIRPRICE', 'purchase', 'dbs-alert', now);

    const result2 = await pipelineService.processDocument('hash2');
    expect(result2.transactionsCreated).toBe(0);
    expect(result2.transactionsMerged).toBe(0);

    const txCount = db.prepare('SELECT COUNT(*) as count FROM transactions').get() as { count: number };
    expect(txCount.count).toBe(1);
  });

  it('creates separate transaction for alert with different timestamp', async () => {
    const documentStore = new LocalDocumentStore(documentsDir);
    const pipelineService = new PipelineService(db, null, [], documentStore);

    const now = Date.now();

    db.prepare('INSERT INTO raw_documents (hash, filename, mime_type, uploaded_at, size_bytes) VALUES (?, ?, ?, ?, ?)').run('hash1', 'alert1.eml', 'message/rfc822', now, 100);
    db.prepare('INSERT INTO observations (id, document_hash, account_hint, amount_cents, currency, timestamp, merchant_text, kind, adapter_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('obs1', 'hash1', '1234', -5000, 'SGD', now, 'FAIRPRICE', 'purchase', 'dbs-alert', now);

    const result1 = await pipelineService.processDocument('hash1');
    expect(result1.transactionsCreated).toBe(1);

    const fiveMinutesLater = now + 5 * 60 * 1000;
    db.prepare('INSERT INTO raw_documents (hash, filename, mime_type, uploaded_at, size_bytes) VALUES (?, ?, ?, ?, ?)').run('hash2', 'alert2.eml', 'message/rfc822', fiveMinutesLater, 100);
    db.prepare('INSERT INTO observations (id, document_hash, account_hint, amount_cents, currency, timestamp, merchant_text, kind, adapter_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('obs2', 'hash2', '1234', -5000, 'SGD', fiveMinutesLater, 'FAIRPRICE', 'purchase', 'dbs-alert', fiveMinutesLater);

    const result2 = await pipelineService.processDocument('hash2');
    expect(result2.transactionsCreated).toBe(1);

    const txCount = db.prepare('SELECT COUNT(*) as count FROM transactions').get() as { count: number };
    expect(txCount.count).toBe(2);
  });
});
