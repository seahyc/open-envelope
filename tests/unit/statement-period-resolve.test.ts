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

const layouts = join(process.cwd(), 'fixtures/layouts');

describe('statement period account resolution', () => {
  let tmpDir: string;
  let db: Database.Database;
  let documentsDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'period-resolve-'));
    documentsDir = join(tmpDir, 'documents');
    mkdirSync(documentsDir, { recursive: true });
    db = initDatabase(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stores the period when the hint only matches a dash-normalised alias', async () => {
    db.prepare(`
      INSERT INTO accounts (id, name, aliases, account_group, created_at)
      VALUES ('ocbc-360', 'OCBC 360', '["501-234567-001"]', 'budget', ?)
    `).run(Date.now());

    const documentStore = new LocalDocumentStore(documentsDir);
    const pipelineService = new PipelineService(db, null, [], documentStore);
    const importService = new ImportService(db, documentStore, defaultRegistry, pipelineService);

    const result = await importService.import(
      'ocbc-360-bank-account.txt',
      readFileSync(join(layouts, 'ocbc-360-bank-account.txt'))
    );

    expect(result.adapterName).toBe('ocbc-360');
    expect(result.observationsCreated).toBe(6);
    expect(result.hasStatementPeriod).toBe(true);

    const periods = db.prepare('SELECT account_id, opening_balance_cents, closing_balance_cents, status FROM statement_periods').all() as Array<{
      account_id: string;
      opening_balance_cents: number;
      closing_balance_cents: number;
      status: string;
    }>;
    expect(periods).toHaveLength(1);
    expect(periods[0]?.account_id).toBe('ocbc-360');
    expect(periods[0]?.opening_balance_cents).toBe(123456);
    expect(periods[0]?.closing_balance_cents).toBe(485231);
    expect(periods[0]?.status).toBe('balanced');

    const txs = db.prepare('SELECT COUNT(*) as count FROM transactions WHERE account_id = ?').get('ocbc-360') as { count: number };
    expect(txs.count).toBe(6);
  });

  it('stores the period when the hint only resolves via folderPattern', async () => {
    db.prepare(`
      INSERT INTO accounts (id, name, aliases, account_group, created_at)
      VALUES ('ocbc-card', 'OCBC Card', '["household-card"]', 'credit', ?)
    `).run(Date.now());

    const documentStore = new LocalDocumentStore(documentsDir);
    const pipelineService = new PipelineService(db, null, [
      { folderPattern: 'OCBC_CreditCard', accountAlias: 'household-card', accountId: 'ocbc-card' },
    ], documentStore);
    const importService = new ImportService(db, documentStore, defaultRegistry, pipelineService);

    const result = await importService.import(
      'OCBC_CreditCard/ocbc-card-90n.txt',
      readFileSync(join(layouts, 'ocbc-card-90n.txt'))
    );

    expect(result.adapterName).toBe('ocbc-card');
    expect(result.observationsCreated).toBe(7);
    expect(result.hasStatementPeriod).toBe(true);

    const periods = db.prepare('SELECT account_id, opening_balance_cents, closing_balance_cents, status FROM statement_periods').all() as Array<{
      account_id: string;
      opening_balance_cents: number;
      closing_balance_cents: number;
      status: string;
    }>;
    expect(periods).toHaveLength(1);
    expect(periods[0]?.account_id).toBe('ocbc-card');
    expect(periods[0]?.opening_balance_cents).toBe(-100000);
    expect(periods[0]?.closing_balance_cents).toBe(-97789);
    expect(periods[0]?.status).toBe('balanced');

    const txs = db.prepare('SELECT COUNT(*) as count FROM transactions WHERE account_id = ?').get('ocbc-card') as { count: number };
    expect(txs.count).toBe(7);
  });
});
