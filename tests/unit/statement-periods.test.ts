import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { initDatabase } from '../../src/server/db/database.js';
import { LocalDocumentStore } from '../../src/server/storage/document-store.js';
import { ImportService } from '../../src/server/services/import-service.js';
import { PipelineService } from '../../src/server/services/pipeline-service.js';
import { defaultRegistry } from '../../src/server/adapters/registry.js';

describe('Statement Periods', () => {
  let tmpDir: string;
  let dbPath: string;
  let documentsDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'statement-test-'));
    dbPath = join(tmpDir, 'test.db');
    documentsDir = join(tmpDir, 'documents');
    mkdirSync(documentsDir, { recursive: true });
    db = initDatabase(dbPath);

    db.prepare(`
      INSERT INTO accounts (id, name, aliases, account_group, created_at)
      VALUES ('dbs-account', 'DBS Account', '["123456789"]', 'budget', ?)
    `).run(Date.now());
  });

  afterEach(() => {
    db.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes statement_periods instead of opening/closing balance transactions', async () => {
    const documentStore = new LocalDocumentStore(documentsDir);
    const pipelineService = new PipelineService(db, null, [], documentStore);
    const importService = new ImportService(db, documentStore, defaultRegistry, pipelineService);

    const statementPath = join(process.cwd(), 'fixtures/singapore/dbs-account-statement.txt');
    const content = readFileSync(statementPath);

    const result = await importService.import('dbs-account-statement.txt', content);

    expect(result.observationsCreated).toBeGreaterThan(0);

    const transactions = db.prepare('SELECT * FROM transactions').all() as any[];
    const periods = db.prepare('SELECT * FROM statement_periods').all() as any[];

    expect(transactions.filter(t => t.merchant_text.includes('Balance')).length).toBe(0);
    
    expect(periods.length).toBe(1);
    const period = periods[0];
    expect(period.opening_balance_cents).toBeGreaterThan(0);
    expect(period.closing_balance_cents).toBeGreaterThan(0);
    expect(period.account_id).toBe('dbs-account');

    const realLineCount = transactions.length;
    expect(realLineCount).toBeGreaterThan(0);
    expect(result.observationsCreated).toBe(realLineCount);
  });
});
