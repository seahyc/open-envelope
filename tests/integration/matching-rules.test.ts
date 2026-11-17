import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { PipelineService } from '../../src/server/services/pipeline-service.js';
import { LLMProvider } from '../../src/server/lib/llm-provider.js';
import crypto from 'crypto';

describe('Transaction Matching Rules', () => {
  let db: Database.Database;
  let tmpDir: string;
  let pipelineService: PipelineService;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'openenvelope-test-'));
    
    const { initDatabase } = await import('../../src/server/db/database.js');
    db = initDatabase(join(tmpDir, 'test.db'));
    
    db.prepare(`
      INSERT INTO accounts (id, name, aliases, account_group, created_at)
      VALUES ('test-account', 'Test Account', '["test"]', 'budget', ?)
    `).run(Date.now());
    
    const llmProvider = new LLMProvider({
      provider: 'none',
      cacheEnabled: false,
      timeout: 30000,
      rateLimit: { requestsPerMinute: 10 },
    });
    
    pipelineService = new PipelineService(db, llmProvider, [
      { accountHint: 'test', accountAlias: 'test', accountId: 'test-account' }
    ]);
  });

  afterEach(() => {
    if (db) db.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('matches SGD amounts within ±1 cent', async () => {
    const docHash = crypto.randomBytes(16).toString('hex');
    const now = Date.now();
    
    db.prepare(`
      INSERT INTO raw_documents (hash, filename, mime_type, uploaded_at, size_bytes)
      VALUES (?, 'test.txt', 'text/plain', ?, 100)
    `).run(docHash, now);
    
    db.prepare(`
      INSERT INTO observations (id, document_hash, account_hint, amount_cents, currency, fx_currency,
        timestamp, merchant_text, kind, adapter_name, created_at)
      VALUES ('obs1', ?, 'test', -10050, 'SGD', NULL, ?, 'Test Merchant', 'purchase', 'test-adapter', ?)
    `).run(docHash, now, now);

    const result = await pipelineService.processDocument(docHash);
    expect(result.transactionsCreated).toBe(1);
    
    const docHash2 = crypto.randomBytes(16).toString('hex');
    db.prepare(`
      INSERT INTO raw_documents (hash, filename, mime_type, uploaded_at, size_bytes)
      VALUES (?, 'test2.txt', 'text/plain', ?, 100)
    `).run(docHash2, now);
    
    db.prepare(`
      INSERT INTO observations (id, document_hash, account_hint, amount_cents, currency, fx_currency,
        timestamp, merchant_text, kind, adapter_name, created_at)
      VALUES ('obs2', ?, 'test', -10051, 'SGD', NULL, ?, 'Test Merchant', 'purchase', 'test-adapter', ?)
    `).run(docHash2, now + 1000, now);
    
    const result2 = await pipelineService.processDocument(docHash2);
    expect(result2.transactionsMerged).toBe(1);
    
    const tx = db.prepare('SELECT * FROM transactions WHERE merchant_text = ?').get('Test Merchant') as any;
    expect(tx.observation_ids).toContain('obs1');
    expect(tx.observation_ids).toContain('obs2');
  });

  it('matches FX amounts within ±3%', async () => {
    const docHash = crypto.randomBytes(16).toString('hex');
    const now = Date.now();
    
    db.prepare(`
      INSERT INTO raw_documents (hash, filename, mime_type, uploaded_at, size_bytes)
      VALUES (?, 'test.txt', 'text/plain', ?, 100)
    `).run(docHash, now);
    
    db.prepare(`
      INSERT INTO observations (id, document_hash, account_hint, amount_cents, currency, fx_currency,
        timestamp, merchant_text, kind, adapter_name, created_at)
      VALUES ('obs-fx1', ?, 'test', -10000, 'USD', 'EUR', ?, 'Foreign Merchant', 'purchase', 'test-adapter', ?)
    `).run(docHash, now, now);
    
    const result = await pipelineService.processDocument(docHash);
    expect(result.transactionsCreated).toBe(1);
    
    const docHash2 = crypto.randomBytes(16).toString('hex');
    db.prepare(`
      INSERT INTO raw_documents (hash, filename, mime_type, uploaded_at, size_bytes)
      VALUES (?, 'test2.txt', 'text/plain', ?, 100)
    `).run(docHash2, now);
    
    db.prepare(`
      INSERT INTO observations (id, document_hash, account_hint, amount_cents, currency, fx_currency,
        timestamp, merchant_text, kind, adapter_name, created_at)
      VALUES ('obs-fx2', ?, 'test', -10250, 'USD', 'EUR', ?, 'Foreign Merchant', 'purchase', 'test-adapter', ?)
    `).run(docHash2, now + 1000, now);
    
    const result2 = await pipelineService.processDocument(docHash2);
    expect(result2.transactionsMerged).toBe(1);
  });

  it('matches statement date from −1 to +3 days relative to alert', async () => {
    const docHash = crypto.randomBytes(16).toString('hex');
    const baseTime = Date.now();
    
    db.prepare(`
      INSERT INTO raw_documents (hash, filename, mime_type, uploaded_at, size_bytes)
      VALUES (?, 'alert.txt', 'text/plain', ?, 100)
    `).run(docHash, baseTime);
    
    db.prepare(`
      INSERT INTO observations (id, document_hash, account_hint, amount_cents, currency, fx_currency,
        timestamp, merchant_text, kind, adapter_name, created_at)
      VALUES ('obs-alert', ?, 'test', -5000, 'SGD', NULL, ?, 'Test Shop', 'purchase', 'email-alert', ?)
    `).run(docHash, baseTime, baseTime);
    
    const result = await pipelineService.processDocument(docHash);
    expect(result.transactionsCreated).toBe(1);
    
    const docHash2 = crypto.randomBytes(16).toString('hex');
    const statementTime = baseTime + (2 * 24 * 60 * 60 * 1000);
    
    db.prepare(`
      INSERT INTO raw_documents (hash, filename, mime_type, uploaded_at, size_bytes)
      VALUES (?, 'statement.csv', 'text/csv', ?, 100)
    `).run(docHash2, baseTime);
    
    db.prepare(`
      INSERT INTO observations (id, document_hash, account_hint, amount_cents, currency, fx_currency,
        timestamp, merchant_text, kind, adapter_name, is_statement, created_at)
      VALUES ('obs-stmt', ?, 'test', -5000, 'SGD', NULL, ?, 'Test Shop', 'purchase', 'csv-adapter', 1, ?)
    `).run(docHash2, statementTime, baseTime);
    
    const result2 = await pipelineService.processDocument(docHash2);
    expect(result2.transactionsMerged).toBe(1);
    
    const tx = db.prepare('SELECT state FROM transactions WHERE merchant_text = ?').get('Test Shop') as any;
    expect(tx.state).toBe('posted');
  });

  it('requires same sign for matching', async () => {
    const docHash = crypto.randomBytes(16).toString('hex');
    const now = Date.now();
    
    db.prepare(`
      INSERT INTO raw_documents (hash, filename, mime_type, uploaded_at, size_bytes)
      VALUES (?, 'test.txt', 'text/plain', ?, 100)
    `).run(docHash, now);
    
    db.prepare(`
      INSERT INTO observations (id, document_hash, account_hint, amount_cents, currency, fx_currency,
        timestamp, merchant_text, kind, adapter_name, created_at)
      VALUES ('obs-neg', ?, 'test', -5000, 'SGD', NULL, ?, 'Test', 'purchase', 'test-adapter', ?)
    `).run(docHash, now, now);
    
    const result = await pipelineService.processDocument(docHash);
    expect(result.transactionsCreated).toBe(1);
    
    const docHash2 = crypto.randomBytes(16).toString('hex');
    db.prepare(`
      INSERT INTO raw_documents (hash, filename, mime_type, uploaded_at, size_bytes)
      VALUES (?, 'test2.txt', 'text/plain', ?, 100)
    `).run(docHash2, now);
    
    db.prepare(`
      INSERT INTO observations (id, document_hash, account_hint, amount_cents, currency, fx_currency,
        timestamp, merchant_text, kind, adapter_name, created_at)
      VALUES ('obs-pos', ?, 'test', 5000, 'SGD', NULL, ?, 'Test', 'deposit', 'test-adapter', ?)
    `).run(docHash2, now + 1000, now);
    
    const result2 = await pipelineService.processDocument(docHash2);
    expect(result2.transactionsCreated).toBe(1);
    expect(result2.transactionsMerged).toBe(0);
    
    const txs = db.prepare('SELECT COUNT(*) as count FROM transactions WHERE merchant_text = ?').get('Test') as { count: number };
    expect(txs.count).toBe(2);
  });

  it('sends ambiguous matches (>1 candidate) to review_queue', async () => {
    const now = Date.now();
    
    const docHash1 = crypto.randomBytes(16).toString('hex');
    db.prepare(`
      INSERT INTO raw_documents (hash, filename, mime_type, uploaded_at, size_bytes)
      VALUES (?, 'alert1.txt', 'text/plain', ?, 100)
    `).run(docHash1, now);
    
    db.prepare(`
      INSERT INTO observations (id, document_hash, account_hint, amount_cents, currency, fx_currency,
        timestamp, merchant_text, kind, adapter_name, created_at)
      VALUES ('obs1', ?, 'test', -5000, 'SGD', NULL, ?, 'Shop', 'purchase', 'email-alert', ?)
    `).run(docHash1, now, now);
    
    await pipelineService.processDocument(docHash1);
    
    const docHash2 = crypto.randomBytes(16).toString('hex');
    db.prepare(`
      INSERT INTO raw_documents (hash, filename, mime_type, uploaded_at, size_bytes)
      VALUES (?, 'alert2.txt', 'text/plain', ?, 100)
    `).run(docHash2, now);
    
    db.prepare(`
      INSERT INTO observations (id, document_hash, account_hint, amount_cents, currency, fx_currency,
        timestamp, merchant_text, kind, adapter_name, created_at)
      VALUES ('obs2', ?, 'test', -5000, 'SGD', NULL, ?, 'Shop', 'purchase', 'email-alert', ?)
    `).run(docHash2, now + (2 * 24 * 60 * 60 * 1000), now);
    
    await pipelineService.processDocument(docHash2);
    
    const docHash3 = crypto.randomBytes(16).toString('hex');
    db.prepare(`
      INSERT INTO raw_documents (hash, filename, mime_type, uploaded_at, size_bytes)
      VALUES (?, 'statement.csv', 'text/csv', ?, 100)
    `).run(docHash3, now);
    
    db.prepare(`
      INSERT INTO observations (id, document_hash, account_hint, amount_cents, currency, fx_currency,
        timestamp, merchant_text, kind, adapter_name, created_at)
      VALUES ('obs3', ?, 'test', -5000, 'SGD', NULL, ?, 'Shop', 'purchase', 'csv-adapter', ?)
    `).run(docHash3, now + (1 * 24 * 60 * 60 * 1000), now);
    
    const result3 = await pipelineService.processDocument(docHash3);
    
    const reviewQueue = db.prepare('SELECT * FROM review_queue WHERE reason = ?').all('ambiguous_match');
    expect(reviewQueue.length).toBeGreaterThan(0);
    
    const txs = db.prepare('SELECT COUNT(*) as count FROM transactions').get() as { count: number };
    expect(txs.count).toBe(2);
  });
});
