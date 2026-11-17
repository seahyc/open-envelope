import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ImportService } from './import-service.js';
import { PipelineService } from './pipeline-service.js';
import { defaultRegistry } from '../adapters/registry.js';
import { runMigrations } from '../db/migrations.js';
import { LocalDocumentStore } from '../storage/document-store.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('End-to-End Pipeline Integration', () => {
  let db: Database.Database;
  let importService: ImportService;
  let pipelineService: PipelineService;
  let documentStore: LocalDocumentStore;
  let storePath: string;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);

    storePath = fs.mkdtempSync(path.join(os.tmpdir(), 'openenvelope-test-'));
    documentStore = new LocalDocumentStore(storePath);

    db.exec(`
      INSERT INTO accounts (id, name, aliases, account_group, opened_at, created_at)
      VALUES 
        ('acct1', 'OCBC Credit Card', '["card-xxxx", "xxxx", "1234"]', 'credit', ${Date.now()}, ${Date.now()}),
        ('acct2', 'DBS Checking', '["yyyy", "5678"]', 'budget', ${Date.now()}, ${Date.now()})
    `);

    pipelineService = new PipelineService(db, null, [
      { accountHint: 'card-xxxx', accountAlias: 'card-xxxx', accountId: 'acct1' },
      { accountHint: 'xxxx', accountAlias: 'xxxx', accountId: 'acct1' },
      { accountHint: 'yyyy', accountAlias: 'yyyy', accountId: 'acct2' },
      { accountHint: 'card-1234', accountAlias: 'card-1234', accountId: 'acct1' },
      { accountHint: '1234', accountAlias: '1234', accountId: 'acct1' },
      { accountHint: '5678', accountAlias: '5678', accountId: 'acct2' },
    ]);

    importService = new ImportService(db, documentStore, defaultRegistry, pipelineService);
  });

  it('processes OCBC alert email + statement into one posted transaction', async () => {
    const alertEmail = Buffer.from(`From: alerts@ocbc.com
To: user@example.com
Subject: OCBC Card Transaction Alert
Message-ID: <test-ocbc-1@ocbc.com>

Transaction alert: Your OCBC card ending in xxxx was used at WHOLE FOODS MARKET for SGD 45.67.
`);

    const result1 = await importService.import('ocbc-alert.eml', alertEmail);
    
    console.log('Import result 1:', result1);
    
    expect(result1.documentHash).toBeDefined();
    
    const allObs = db.prepare('SELECT * FROM observations').all();
    console.log('All observations:', allObs);
    
    expect(result1.observationsCreated).toBeGreaterThan(0);

    const allTxs = db.prepare('SELECT * FROM transactions').all();
    console.log('All transactions after alert:', allTxs);

    const pendingTx = db
      .prepare('SELECT * FROM transactions WHERE account_id = ? AND state = ?')
      .get('acct1', 'pending') as any;

    console.log('Pending tx query result:', pendingTx);

    expect(pendingTx).toBeDefined();
    expect(pendingTx.merchant_text).toContain('WHOLE FOODS');
    expect(Math.abs(pendingTx.amount_cents - (-4567))).toBeLessThan(100);

    const statementCsv = Buffer.from(`Date,Description,Amount,Account
${new Date().toISOString().split('T')[0]},WHOLE FOODS MARKET,-45.67,xxxx
`);

    const result2 = await importService.import('ocbc-statement.csv', statementCsv);
    
    expect(result2.documentHash).toBeDefined();
    expect(result2.observationsCreated).toBeGreaterThan(0);

    const postedTx = db
      .prepare('SELECT * FROM transactions WHERE account_id = ? AND merchant_text LIKE ?')
      .get('acct1', '%WHOLE FOODS%') as any;

    expect(postedTx).toBeDefined();
    expect(postedTx.state).toBe('posted');
    
    const observationIds = JSON.parse(postedTx.observation_ids);
    expect(observationIds.length).toBe(2);

    const allTx = db
      .prepare('SELECT COUNT(*) as count FROM transactions WHERE account_id = ?')
      .get('acct1') as { count: number };
    
    expect(allTx.count).toBe(1);
  });

  it('handles re-importing same email as no-op', async () => {
    const alertEmail = Buffer.from(`From: alerts@ocbc.com
Subject: Transaction Alert
Message-ID: <duplicate-test@ocbc.com>

Transaction alert: Your OCBC card ending in xxxx was used at Test Merchant for SGD 10.00.
`);

    const result1 = await importService.import('test1.eml', alertEmail);
    expect(result1.observationsCreated).toBeGreaterThan(0);

    const result2 = await importService.import('test2.eml', alertEmail);
    expect(result2.observationsCreated).toBe(0);
  });
});
