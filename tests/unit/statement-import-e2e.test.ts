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

describe('Singapore fixture import end-to-end', () => {
  let tmpDir: string;
  let db: Database.Database;
  let importService: ImportService;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sg-e2e-'));
    const documentsDir = join(tmpDir, 'documents');
    mkdirSync(documentsDir, { recursive: true });
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

    const documentStore = new LocalDocumentStore(documentsDir);
    const pipelineService = new PipelineService(db, null, mappings, documentStore);
    importService = new ImportService(db, documentStore, defaultRegistry, pipelineService);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function importFixtures(): Promise<void> {
    const fixturesDir = join(process.cwd(), 'fixtures/singapore');
    const files = readdirSync(fixturesDir).filter((name) => !/\.ya?ml$/i.test(name) && !name.endsWith('.pdf'));
    for (const name of files) {
      await importService.import(name, readFileSync(join(fixturesDir, name)));
    }
  }

  it('creates 0 unmatched observations for the fixture set', async () => {
    await importFixtures();

    const unmatched = db.prepare(
      "SELECT COUNT(*) as count FROM review_queue WHERE reason = 'unmatched_account'"
    ).get() as { count: number };
    expect(unmatched.count).toBe(0);

    const hints = db.prepare('SELECT DISTINCT account_hint FROM observations').all() as Array<{ account_hint: string }>;
    const accounts = db.prepare('SELECT aliases FROM accounts').all() as Array<{ aliases: string }>;
    const aliasSet = new Set(accounts.flatMap((row) => JSON.parse(row.aliases) as string[]));
    for (const row of hints) {
      expect(aliasSet.has(row.account_hint)).toBe(true);
    }
  });

  it('posts every statement line, balances every period, and merges alerts', async () => {
    await importFixtures();

    const statementObs = db.prepare('SELECT * FROM observations WHERE is_statement = 1').all() as Array<{
      id: string;
      adapter_name: string;
      merchant_text: string;
    }>;
    expect(statementObs.length).toBe(8 + 8 + 7 + 7 + 5);

    for (const obs of statementObs) {
      const tx = db.prepare(
        `SELECT state FROM transactions WHERE observation_ids LIKE ?`
      ).get(`%${obs.id}%`) as { state: string } | undefined;
      expect(tx, `missing tx for ${obs.adapter_name} ${obs.merchant_text}`).toBeDefined();
      expect(['posted', 'reconciled']).toContain(tx!.state);
    }

    const periods = db.prepare('SELECT * FROM statement_periods').all() as Array<{
      account_id: string;
      status: string;
      discrepancy_cents: number | null;
      opening_balance_cents: number;
      closing_balance_cents: number;
    }>;
    expect(periods.length).toBe(7);
    for (const period of periods) {
      expect(period.status).toBe('balanced');
      expect(period.discrepancy_cents ?? 0).toBe(0);
    }

    expect(periods.some((period) => period.account_id.includes('ocbc-360'))).toBe(true);
    expect(periods.filter((period) => period.account_id.startsWith('cpf-')).length).toBe(3);

    const ocbcFairprice = db.prepare(
      `SELECT observation_ids, state FROM transactions WHERE merchant_text LIKE '%FAIRPRICE FINEST ORCHARD%'`
    ).get() as { observation_ids: string; state: string };
    expect(JSON.parse(ocbcFairprice.observation_ids)).toHaveLength(2);
    expect(ocbcFairprice.state).toBe('posted');

    const dbsFairprice = db.prepare(
      `SELECT observation_ids, state FROM transactions WHERE merchant_text = 'FAIRPRICE FINEST'`
    ).get() as { observation_ids: string; state: string };
    expect(JSON.parse(dbsFairprice.observation_ids)).toHaveLength(2);
    expect(dbsFairprice.state).toBe('posted');

    const unmatched = db.prepare(
      "SELECT COUNT(*) as count FROM review_queue WHERE reason = 'unmatched_account'"
    ).get() as { count: number };
    expect(unmatched.count).toBe(0);

    const unbalanced = db.prepare(
      "SELECT COUNT(*) as count FROM review_queue WHERE reason = 'unbalanced_period'"
    ).get() as { count: number };
    expect(unbalanced.count).toBe(0);
  });
});
