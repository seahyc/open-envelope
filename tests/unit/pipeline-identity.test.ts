import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';
import { initDatabase } from '../../src/server/db/database.js';
import { LocalDocumentStore } from '../../src/server/storage/document-store.js';
import { ImportService } from '../../src/server/services/import-service.js';
import { PipelineService } from '../../src/server/services/pipeline-service.js';
import { defaultRegistry } from '../../src/server/adapters/registry.js';

interface AccountConfig {
  accountAlias: string;
  accountName?: string;
  accountType?: string;
  aliases?: string[];
  folderPattern?: string;
}

describe('declarative pipeline identity on fixtures', () => {
  let tmpDir: string;
  let db: Database.Database;
  let importService: ImportService;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pipeline-id-'));
    mkdirSync(join(tmpDir, 'documents'), { recursive: true });
    db = initDatabase(join(tmpDir, 'test.db'));

    const config = parse(readFileSync(join(process.cwd(), 'fixtures/singapore/accounts.yaml'), 'utf-8')) as {
      accounts: AccountConfig[];
    };
    const mappings = config.accounts.map((account) => {
      const accountId = `${(account.accountName || account.accountAlias).toLowerCase().replace(/\s+/g, '-')}`;
      const aliases = account.aliases || [account.accountAlias];
      db.prepare(`
        INSERT INTO accounts (id, name, aliases, account_group, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(accountId, account.accountName || account.accountAlias, JSON.stringify(aliases), account.accountType || 'budget', Date.now());
      return {
        folderPattern: account.folderPattern,
        accountAlias: account.accountAlias,
        accountHint: account.accountAlias,
        accountId,
      };
    });

    const documentStore = new LocalDocumentStore(join(tmpDir, 'documents'));
    const pipelineService = new PipelineService(db, null, mappings, documentStore);
    importService = new ImportService(db, documentStore, defaultRegistry, pipelineService);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('imports the Singapore fixture set with the same posted/balanced totals as before', async () => {
    const fixturesDir = join(process.cwd(), 'fixtures/singapore');
    const files = readdirSync(fixturesDir).filter((name) => !/\.ya?ml$/i.test(name) && !name.endsWith('.pdf'));
    for (const name of files) {
      await importService.import(name, readFileSync(join(fixturesDir, name)));
    }

    const statementObs = db.prepare('SELECT COUNT(*) as count FROM observations WHERE is_statement = 1').get() as { count: number };
    expect(statementObs.count).toBe(8 + 8 + 7 + 7 + 5);

    const periods = db.prepare('SELECT status, discrepancy_cents FROM statement_periods').all() as Array<{
      status: string;
      discrepancy_cents: number | null;
    }>;
    expect(periods).toHaveLength(7);
    for (const period of periods) {
      expect(period.status).toBe('balanced');
      expect(period.discrepancy_cents ?? 0).toBe(0);
    }

    const unmatched = db.prepare(
      "SELECT COUNT(*) as count FROM review_queue WHERE reason = 'unmatched_account'"
    ).get() as { count: number };
    expect(unmatched.count).toBe(0);

    const runs = db.prepare('SELECT COUNT(*) as count FROM pipeline_runs').get() as { count: number };
    expect(runs.count).toBeGreaterThan(0);
    const stages = db.prepare('SELECT stage_name FROM stage_runs').all() as Array<{ stage_name: string }>;
    expect(stages.some((row) => row.stage_name === 'ingest')).toBe(true);
    expect(stages.some((row) => row.stage_name === 'detect-format')).toBe(true);
    expect(stages.some((row) => row.stage_name === 'parse')).toBe(true);
    expect(stages.some((row) => row.stage_name === 'match')).toBe(true);
  });
});
