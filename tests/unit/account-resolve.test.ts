import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { initDatabase } from '../../src/server/db/database.js';
import { LocalDocumentStore } from '../../src/server/storage/document-store.js';
import { PipelineService } from '../../src/server/services/pipeline-service.js';

describe('resolveAccount exact aliases and folderPattern', () => {
  let tmpDir: string;
  let db: Database.Database;
  let documentsDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'account-resolve-'));
    documentsDir = join(tmpDir, 'documents');
    mkdirSync(documentsDir, { recursive: true });
    db = initDatabase(join(tmpDir, 'test.db'));

    const now = Date.now();
    db.prepare(`
      INSERT INTO accounts (id, name, aliases, account_group, created_at)
      VALUES
        ('dbs-account', 'DBS Account', '["123456789"]', 'budget', ?),
        ('dbs-card', 'DBS Card', '["card-6789"]', 'credit', ?),
        ('ocbc-folder', 'OCBC from folder', '["card-2345"]', 'credit', ?)
    `).run(now, now, now);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('matches aliases exactly and does not substring-match 6789 to 123456789', async () => {
    const documentStore = new LocalDocumentStore(documentsDir);
    const pipeline = new PipelineService(db, null, [], documentStore);

    db.prepare(`
      INSERT INTO raw_documents (hash, filename, mime_type, uploaded_at, size_bytes)
      VALUES ('hash-sub', 'alert.eml', 'message/rfc822', ?, 10)
    `).run(Date.now());
    db.prepare(`
      INSERT INTO observations (id, document_hash, account_hint, amount_cents, currency, timestamp, merchant_text, kind, adapter_name, is_statement, created_at)
      VALUES ('obs-sub', 'hash-sub', '6789', -1000, 'SGD', ?, 'SHOP', 'purchase', 'dbs-alert', 0, ?)
    `).run(Date.now(), Date.now());

    const result = await pipeline.processDocument('hash-sub');
    expect(result.errors.some((error) => error.includes('Unmatched account hint: 6789'))).toBe(true);
    expect(db.prepare('SELECT COUNT(*) as count FROM transactions').get() as { count: number }).toEqual({ count: 0 });
  });

  it('honours folderPattern when the hint is unknown', async () => {
    const documentStore = new LocalDocumentStore(documentsDir);
    const pipeline = new PipelineService(db, null, [
      { folderPattern: 'OCBC_CreditCard', accountAlias: 'card-2345', accountId: 'ocbc-folder' },
    ], documentStore);

    db.prepare(`
      INSERT INTO raw_documents (hash, filename, mime_type, uploaded_at, size_bytes)
      VALUES ('hash-folder', 'OCBC_CreditCard/statement.txt', 'text/plain', ?, 10)
    `).run(Date.now());
    db.prepare(`
      INSERT INTO observations (id, document_hash, account_hint, amount_cents, currency, timestamp, merchant_text, kind, adapter_name, is_statement, created_at)
      VALUES ('obs-folder', 'hash-folder', 'unknown', -12550, 'SGD', ?, 'FAIRPRICE', 'purchase', 'ocbc-card', 1, ?)
    `).run(Date.now(), Date.now());

    const result = await pipeline.processDocument('hash-folder');
    expect(result.errors).toEqual([]);
    expect(result.transactionsCreated).toBe(1);

    const tx = db.prepare('SELECT account_id, state FROM transactions').get() as { account_id: string; state: string };
    expect(tx.account_id).toBe('ocbc-folder');
    expect(tx.state).toBe('posted');
  });
});
