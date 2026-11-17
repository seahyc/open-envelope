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

describe('CLI Integration on fixtures/singapore', () => {
  let tmpDir: string;
  let dbPath: string;
  let documentsDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cli-sg-test-'));
    dbPath = join(tmpDir, 'test.db');
    documentsDir = join(tmpDir, 'documents');
    mkdirSync(documentsDir, { recursive: true });
    db = initDatabase(dbPath);

    db.prepare(`
      INSERT INTO accounts (id, name, aliases, account_group, created_at)
      VALUES 
        ('ocbc-card-2345', 'OCBC Card 2345', '["card-2345"]', 'credit', ?),
        ('dbs-card-6789', 'DBS Card 6789', '["card-6789"]', 'credit', ?),
        ('dbs-acct-6789', 'DBS Account', '["123456789"]', 'budget', ?),
        ('ocbc-360-1234', 'OCBC 360', '["501123456001"]', 'budget', ?)
    `).run(Date.now(), Date.now(), Date.now(), Date.now());
  });

  afterEach(() => {
    db.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('OCBC card alert merges with statement line into ONE transaction', async () => {
    const documentStore = new LocalDocumentStore(documentsDir);
    const pipelineService = new PipelineService(db, null, [
      { accountHint: 'card-2345', accountAlias: 'card-2345', accountId: 'ocbc-card-2345' },
      { accountHint: '2345', accountAlias: '2345', accountId: 'ocbc-card-2345' },
    ], documentStore);
    const importService = new ImportService(db, documentStore, defaultRegistry, pipelineService);

    const alertPath = join(process.cwd(), 'fixtures/singapore/ocbc-card-alert.eml');
    const statementPath = join(process.cwd(), 'fixtures/singapore/ocbc-card-statement.txt');

    const alertContent = readFileSync(alertPath);
    const statementContent = readFileSync(statementPath);

    const alertResult = await importService.import('ocbc-card-alert.eml', alertContent);
    expect(alertResult.observationsCreated).toBeGreaterThanOrEqual(1);

    const statementResult = await importService.import('ocbc-card-statement.txt', statementContent);
    expect(statementResult.observationsCreated).toBeGreaterThan(0);

    const transactions = db.prepare('SELECT * FROM transactions WHERE account_id = ?').all('ocbc-card-2345') as any[];
    
    const fairprice = transactions.find((tx: any) => tx.merchant_text.includes('FAIRPRICE'));
    expect(fairprice).toBeDefined();
    expect(fairprice!.state).toBe('posted');
    
    const observationIds = JSON.parse(fairprice!.observation_ids);
    expect(observationIds.length).toBe(2);

    const allObservations = db.prepare('SELECT * FROM observations').all() as any[];
    const statementLines = allObservations.filter((obs: any) => obs.adapter_name === 'ocbc-card');
    
    expect(statementLines.length).toBe(7);

    const fairpriceObs = statementLines.find((obs: any) => obs.merchant_text.includes('FAIRPRICE FINEST'));
    expect(fairpriceObs).toBeDefined();
    expect(fairpriceObs!.timestamp).toBe(new Date(2024, 0, 16).getTime());

    const mcdonaldsObs = statementLines.find((obs: any) => obs.merchant_text.includes("MCDONALD'S"));
    expect(mcdonaldsObs).toBeDefined();
    expect(mcdonaldsObs!.timestamp).toBe(new Date(2024, 0, 29).getTime());

    const statementPeriods = db.prepare('SELECT * FROM statement_periods WHERE account_id = ?').all('ocbc-card-2345') as any[];
    expect(statementPeriods.length).toBeGreaterThanOrEqual(1);

    console.log(`Total transactions: ${transactions.length}`);
    console.log(`Statement observations: ${statementLines.length}`);
    console.log(`Statement periods: ${statementPeriods.length}`);
  });
});
