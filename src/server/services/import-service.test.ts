import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ImportService } from './import-service';
import { LocalDocumentStore } from '../storage/document-store';
import { CsvAdapter } from '../adapters/csv-adapter';
import { initDatabase, closeDatabase } from '../db/database';
import type Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('ImportService', () => {
  let db: Database.Database;
  let storePath: string;
  let documentStore: LocalDocumentStore;
  let service: ImportService;

  beforeEach(() => {
    db = initDatabase(':memory:');
    storePath = fs.mkdtempSync(path.join(os.tmpdir(), 'openenvelope-test-'));
    documentStore = new LocalDocumentStore(storePath);
    
    const adapters = [
      new CsvAdapter({
        accountHint: '1234',
        dateColumn: 'Date',
        amountColumn: 'Amount',
        merchantColumn: 'Description',
      }),
    ];

    const pipelineService = {
      processDocument: async () => ({ transactionsCreated: 2, transactionsMerged: 1 }),
    } as any;
    const registry = { findBestAdapter: async () => ({ adapter: adapters[0]!, confidence: 0.9 }) } as any;
    service = new ImportService(db, documentStore, registry, pipelineService);
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(storePath, { recursive: true, force: true });
  });

  it('should import and deduplicate observations', async () => {
    const csv = `Date,Amount,Description
2024-01-15,-52.13,Whole Foods Market
2024-01-16,-12.50,Coffee Shop`;

    const buffer = Buffer.from(csv);
    
    const result1 = await service.import('test.csv', buffer);
    expect(result1.observationsCreated).toBe(2);
    expect(result1.observationsDuplicate).toBe(0);
    expect(result1.transactionsCreated).toBe(2);
    expect(result1.transactionsMerged).toBe(1);

    const result2 = await service.import('test.csv', buffer);
    expect(result2.observationsCreated).toBe(0);
    expect(result2.observationsDuplicate).toBe(0);
  });

  it('should store documents with content hash', async () => {
    const csv = `Date,Amount,Description
2024-01-15,-52.13,Test Merchant`;

    const buffer = Buffer.from(csv);
    const result = await service.import('test.csv', buffer);

    expect(result.documentHash).toBeTruthy();
    
    const doc = db.prepare('SELECT * FROM raw_documents WHERE hash = ?').get(result.documentHash) as {
      hash: string;
      filename: string;
    } | undefined;
    expect(doc).toBeTruthy();
    expect(doc?.filename).toBe('test.csv');

    const retrieved = await documentStore.retrieve(result.documentHash);
    expect(retrieved.toString()).toBe(csv);
  });

  it('should be idempotent on same file import', async () => {
    const csv = `Date,Amount,Description
2024-01-15,-52.13,Whole Foods Market`;

    const buffer = Buffer.from(csv);
    
    await service.import('test.csv', buffer);
    const obsCount1 = (db.prepare('SELECT COUNT(*) as count FROM observations').get() as { count: number }).count;

    await service.import('test-copy.csv', buffer);
    const obsCount2 = (db.prepare('SELECT COUNT(*) as count FROM observations').get() as { count: number }).count;

    expect(obsCount1).toBe(obsCount2);
  });
});
