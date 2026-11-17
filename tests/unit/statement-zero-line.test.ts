import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { initDatabase } from '../../src/server/db/database.js';
import { LocalDocumentStore } from '../../src/server/storage/document-store.js';
import { ImportService } from '../../src/server/services/import-service.js';
import { PipelineService } from '../../src/server/services/pipeline-service.js';
import { defaultRegistry } from '../../src/server/adapters/registry.js';
import type { LLMProvider } from '../../src/server/lib/llm-provider.js';

describe('0-line statement periods', () => {
  let tmpDir: string;
  let db: Database.Database;
  let importService: ImportService;
  let parseUnknownStatement: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'zero-line-'));
    mkdirSync(join(tmpDir, 'documents'), { recursive: true });
    db = initDatabase(join(tmpDir, 'test.db'));
    db.prepare(`
      INSERT INTO accounts (id, name, aliases, account_group, created_at)
      VALUES
        ('posb-esavings', 'POSB eSavings', '["112609016"]', 'budget', ?),
        ('dbs-card', 'DBS Card', '["card-4455"]', 'credit', ?)
    `).run(Date.now(), Date.now());

    parseUnknownStatement = vi.fn().mockResolvedValue([
      { date: '2026-09-01', merchant: 'HALLUCINATED', amount: 9.99 },
    ]);
    const llm = {
      parseUnknownStatement,
      categorizeMerchant: vi.fn().mockResolvedValue(null),
      normalizeMerchant: vi.fn().mockResolvedValue(null),
    } as unknown as LLMProvider;

    const documentStore = new LocalDocumentStore(join(tmpDir, 'documents'));
    const pipelineService = new PipelineService(db, llm, [], documentStore);
    importService = new ImportService(db, documentStore, defaultRegistry, pipelineService);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('records a 0-line period for a quiet month and does not call the LLM fallback', async () => {
    const result = await importService.import(
      'dbs-posb-quiet.txt',
      readFileSync(join(process.cwd(), 'fixtures/layouts/dbs-posb-quiet.txt'))
    );

    expect(result.adapterName).toBe('dbs-account');
    expect(result.observationsCreated).toBe(0);
    expect(result.errors).toEqual([]);
    expect(parseUnknownStatement).not.toHaveBeenCalled();

    const periods = db.prepare('SELECT * FROM statement_periods').all() as Array<{
      opening_balance_cents: number;
      closing_balance_cents: number;
      status: string;
    }>;
    expect(periods).toHaveLength(1);
    expect(periods[0]?.opening_balance_cents).toBe(32539);
    expect(periods[0]?.closing_balance_cents).toBe(32539);
    expect(periods[0]?.status).toBe('balanced');
  });

  it('records a 0-line credit-card carry-over and does not report it as unrecognised', async () => {
    const result = await importService.import(
      'dbs-card-credit-zero.txt',
      readFileSync(join(process.cwd(), 'fixtures/layouts/dbs-card-credit-zero.txt'))
    );
    expect(result.adapterName).toBe('dbs-card');
    expect(result.observationsCreated).toBe(0);
    expect(result.errors).toEqual([]);
    expect(parseUnknownStatement).not.toHaveBeenCalled();
    const periods = db.prepare('SELECT opening_balance_cents, closing_balance_cents FROM statement_periods').all() as Array<{
      opening_balance_cents: number;
      closing_balance_cents: number;
    }>;
    expect(periods[0]?.opening_balance_cents).toBe(19620);
    expect(periods[0]?.closing_balance_cents).toBe(19620);
  });

  it('surfaces adapter matched but parsed 0 lines while balances differ', async () => {
    const mismatch = `
DBS/POSB Consolidated Statement
Statement Period: 01 OCT 2026 to 31 OCT 2026

POSB eSavings Account
Account No. 112-60901-6

Balance Brought Forward                                              325.39
Total Withdrawals                                                     40.00
Total Deposits                                                         0.00
Total Balance Carried Forward:                                       285.39
`;
    const result = await importService.import('quiet-mismatch.txt', Buffer.from(mismatch));
    expect(result.adapterName).toBe('dbs-account');
    expect(result.observationsCreated).toBe(0);
    expect(result.errors.join(' ')).toMatch(/adapter matched but parsed 0 lines while balances differ/i);
    expect(parseUnknownStatement).not.toHaveBeenCalled();

    const review = db.prepare('SELECT reason, detail FROM review_queue').all() as Array<{
      reason: string;
      detail: string;
    }>;
    expect(review.some((row) => /adapter matched but parsed 0 lines while balances differ/i.test(row.detail))).toBe(true);
  });

  it('imports a summary-only POSB quiet month as success with a 0-line period', async () => {
    const result = await importService.import(
      'dbs-posb-quiet-summary.txt',
      readFileSync(join(process.cwd(), 'fixtures/layouts/dbs-posb-quiet-summary.txt'))
    );
    expect(result.adapterName).toBe('dbs-account');
    expect(result.observationsCreated).toBe(0);
    expect(result.hasStatementPeriod).toBe(true);
    expect(result.errors).toEqual([]);
    expect(parseUnknownStatement).not.toHaveBeenCalled();
  });

  it('reports a recognized 0-line statement even when the account hint is unknown', async () => {
    db.prepare('DELETE FROM accounts').run();
    const result = await importService.import(
      'dbs-posb-quiet.txt',
      readFileSync(join(process.cwd(), 'fixtures/layouts/dbs-posb-quiet.txt'))
    );
    expect(result.adapterName).toBe('dbs-account');
    expect(result.observationsCreated).toBe(0);
    expect(result.hasStatementPeriod).toBe(true);
    expect(result.errors).toEqual([]);
    expect(parseUnknownStatement).not.toHaveBeenCalled();
  });
});
