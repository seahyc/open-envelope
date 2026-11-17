import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import crypto from 'crypto';
import { initDatabase } from '../../src/server/db/database.js';
import { LocalDocumentStore } from '../../src/server/storage/document-store.js';
import { ImportService } from '../../src/server/services/import-service.js';
import { PipelineService } from '../../src/server/services/pipeline-service.js';
import { defaultRegistry } from '../../src/server/adapters/registry.js';
import { ReconciliationService, endOfDay } from '../../src/server/services/reconciliation-service.js';
import { OcbcCardAdapter } from '../../src/server/adapters/singapore/ocbc-card-adapter.js';
import { Ocbc360Adapter } from '../../src/server/adapters/singapore/ocbc-360-adapter.js';

const layouts = join(process.cwd(), 'fixtures/layouts');

function dateWindowSum(
  db: Database.Database,
  accountId: string,
  startDate: number,
  endDate: number
): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(amount_cents), 0) as total
    FROM transactions
    WHERE account_id = ?
      AND timestamp >= ?
      AND timestamp <= ?
      AND state IN ('posted', 'reconciled')
  `).get(accountId, startDate, endDate) as { total: number };
  return row.total;
}

function insertPostedTx(
  db: Database.Database,
  opts: {
    accountId: string;
    amountCents: number;
    timestamp: number;
    merchant: string;
    observationIds: string[];
  }
): string {
  const id = crypto.randomBytes(8).toString('hex');
  db.prepare(`
    INSERT INTO transactions (
      id, account_id, amount_cents, currency, timestamp,
      merchant_text, state, observation_ids, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'posted', ?, ?, ?)
  `).run(
    id,
    opts.accountId,
    opts.amountCents,
    'SGD',
    opts.timestamp,
    opts.merchant,
    JSON.stringify(opts.observationIds),
    opts.timestamp,
    opts.timestamp
  );
  return id;
}

describe('OcbcCardAdapter pre-start and gap-day layouts', () => {
  const adapter = new OcbcCardAdapter();

  it('parses a Jan 24 cycle with a transaction inside the window', async () => {
    const result = await adapter.parse(readFileSync(join(layouts, 'ocbc-card-cycle-jan.txt')));
    expect(result.observations).toHaveLength(1);
    expect(result.statementPeriod?.startDate).toBe(new Date(2025, 11, 25).getTime());
    expect(result.statementPeriod?.endDate).toBe(new Date(2026, 0, 24).getTime());
    expect(result.observations[0]?.timestamp).toBe(new Date(2026, 0, 10).getTime());
    const sum = result.observations.reduce((total, obs) => total + obs.amountCents, 0);
    expect(result.statementPeriod!.openingBalanceCents + sum).toBe(result.statementPeriod!.closingBalanceCents);
  });

  it('parses a Feb 28 cycle with a pre-start date and a gap-day date', async () => {
    const result = await adapter.parse(readFileSync(join(layouts, 'ocbc-card-cycle-feb.txt')));
    expect(result.observations).toHaveLength(3);
    expect(result.statementPeriod?.startDate).toBe(new Date(2026, 0, 29).getTime());
    expect(result.statementPeriod?.endDate).toBe(new Date(2026, 1, 28).getTime());

    const preStart = result.observations.find((obs) => obs.merchantText.includes('PRE START'));
    const gap = result.observations.find((obs) => obs.merchantText.includes('GAP DAY'));
    const inWindow = result.observations.find((obs) => obs.merchantText.includes('FEB COFFEE'));
    expect(preStart?.timestamp).toBe(new Date(2026, 0, 20).getTime());
    expect(gap?.timestamp).toBe(new Date(2026, 0, 26).getTime());
    expect(inWindow?.timestamp).toBe(new Date(2026, 1, 5).getTime());
    expect(preStart!.timestamp).toBeLessThan(result.statementPeriod!.startDate);
    expect(gap!.timestamp).toBeGreaterThan(new Date(2026, 0, 24).getTime());
    expect(gap!.timestamp).toBeLessThan(result.statementPeriod!.startDate);

    const sum = result.observations.reduce((total, obs) => total + obs.amountCents, 0);
    expect(result.statementPeriod!.openingBalanceCents + sum).toBe(result.statementPeriod!.closingBalanceCents);
  });
});

describe('Ocbc360Adapter boundary-day interest layout', () => {
  it('parses interest posted on the period end date', async () => {
    const adapter = new Ocbc360Adapter();
    const result = await adapter.parse(readFileSync(join(layouts, 'ocbc-360-boundary-interest.txt')));
    const interest = result.observations.find((obs) => obs.merchantText.includes('INTEREST'));
    expect(interest?.amountCents).toBe(125);
    expect(interest?.timestamp).toBe(new Date(2026, 7, 31).getTime());
    expect(interest?.timestamp).toBe(result.statementPeriod?.endDate);
    const sum = result.observations.reduce((total, obs) => total + obs.amountCents, 0);
    expect(result.statementPeriod!.openingBalanceCents + sum).toBe(result.statementPeriod!.closingBalanceCents);
  });
});

describe('statement period document-sourced reconcile', () => {
  let tmpDir: string;
  let db: Database.Database;
  let importService: ImportService;
  let reconciliation: ReconciliationService;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'period-doc-'));
    mkdirSync(join(tmpDir, 'documents'), { recursive: true });
    db = initDatabase(join(tmpDir, 'test.db'));
    db.prepare(`
      INSERT INTO accounts (id, name, aliases, account_group, created_at)
      VALUES
        ('ocbc-card-4411', 'OCBC Card 4411', '["card-4411"]', 'credit', ?),
        ('ocbc-360-8888', 'OCBC 360 8888', '["501888888001"]', 'budget', ?)
    `).run(Date.now(), Date.now());
    const documentStore = new LocalDocumentStore(join(tmpDir, 'documents'));
    const pipelineService = new PipelineService(db, null, [], documentStore);
    importService = new ImportService(db, documentStore, defaultRegistry, pipelineService);
    reconciliation = new ReconciliationService(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('keeps card periods balanced when txn dates fall before start or in the gap', async () => {
    await importService.import('ocbc-card-cycle-jan.txt', readFileSync(join(layouts, 'ocbc-card-cycle-jan.txt')));
    await importService.import('ocbc-card-cycle-feb.txt', readFileSync(join(layouts, 'ocbc-card-cycle-feb.txt')));

    const periods = db.prepare(
      'SELECT * FROM statement_periods WHERE account_id = ? ORDER BY end_date'
    ).all('ocbc-card-4411') as Array<{
      id: string;
      start_date: number;
      end_date: number;
      opening_balance_cents: number;
      closing_balance_cents: number;
      status: string;
      discrepancy_cents: number | null;
      document_hash: string;
    }>;
    expect(periods).toHaveLength(2);

    const jan = periods[0]!;
    const feb = periods[1]!;
    expect(jan.status).toBe('balanced');
    expect(feb.status).toBe('balanced');
    expect(jan.discrepancy_cents).toBe(0);
    expect(feb.discrepancy_cents).toBe(0);

    const preStart = db.prepare(
      "SELECT timestamp FROM transactions WHERE merchant_text LIKE '%PRE START%'"
    ).get() as { timestamp: number };
    const gap = db.prepare(
      "SELECT timestamp FROM transactions WHERE merchant_text LIKE '%GAP DAY%'"
    ).get() as { timestamp: number };
    expect(preStart.timestamp).toBeGreaterThanOrEqual(jan.start_date);
    expect(preStart.timestamp).toBeLessThanOrEqual(jan.end_date);
    expect(gap.timestamp).toBeGreaterThan(jan.end_date);
    expect(gap.timestamp).toBeLessThan(feb.start_date);

    const janDateWindow = jan.opening_balance_cents + dateWindowSum(db, 'ocbc-card-4411', jan.start_date, jan.end_date);
    expect(janDateWindow).not.toBe(jan.closing_balance_cents);

    const febDateWindow = feb.opening_balance_cents + dateWindowSum(db, 'ocbc-card-4411', feb.start_date, feb.end_date);
    expect(febDateWindow).not.toBe(feb.closing_balance_cents);

    const unbalanced = db.prepare(
      "SELECT COUNT(*) as count FROM review_queue WHERE reason = 'unbalanced_period' AND resolved = 0"
    ).get() as { count: number };
    expect(unbalanced.count).toBe(0);
  });

  it('includes boundary-day interest even when the timestamp is after end_date midnight', async () => {
    await importService.import(
      'ocbc-360-boundary-interest.txt',
      readFileSync(join(layouts, 'ocbc-360-boundary-interest.txt'))
    );

    const period = db.prepare(
      'SELECT * FROM statement_periods WHERE account_id = ?'
    ).get('ocbc-360-8888') as {
      id: string;
      start_date: number;
      end_date: number;
      opening_balance_cents: number;
      closing_balance_cents: number;
      status: string;
      discrepancy_cents: number | null;
    };
    expect(period.status).toBe('balanced');

    const afternoon = new Date(2026, 7, 31, 15, 0, 0).getTime();
    db.prepare("UPDATE transactions SET timestamp = ? WHERE merchant_text LIKE '%INTEREST%'").run(afternoon);

    const dateWindow = period.opening_balance_cents + dateWindowSum(db, 'ocbc-360-8888', period.start_date, period.end_date);
    expect(dateWindow).not.toBe(period.closing_balance_cents);
    expect(afternoon).toBeGreaterThan(period.end_date);
    expect(afternoon).toBeLessThanOrEqual(endOfDay(period.end_date));

    const result = reconciliation.reconcilePeriod(period.id);
    expect(result.success).toBe(true);
    expect(result.discrepancyCents).toBe(0);

    const after = db.prepare('SELECT status, discrepancy_cents FROM statement_periods WHERE id = ?').get(period.id) as {
      status: string;
      discrepancy_cents: number;
    };
    expect(after.status).toBe('balanced');
    expect(after.discrepancy_cents).toBe(0);
  });

  it('recomputes all periods and resolves stale unbalanced_period reviews', async () => {
    await importService.import('ocbc-card-cycle-jan.txt', readFileSync(join(layouts, 'ocbc-card-cycle-jan.txt')));
    const period = db.prepare('SELECT id, document_hash FROM statement_periods').get() as {
      id: string;
      document_hash: string;
    };

    db.prepare(`
      UPDATE statement_periods SET status = 'unbalanced', discrepancy_cents = -5000 WHERE id = ?
    `).run(period.id);
    db.prepare(`
      INSERT INTO review_queue (id, observation_id, document_hash, reason, detail, created_at)
      VALUES (?, NULL, ?, 'unbalanced_period', ?, ?)
    `).run(
      'legacy-unbalanced-1',
      period.document_hash,
      JSON.stringify({ periodId: period.id, discrepancyCents: -5000 }),
      Date.now()
    );

    const summary = reconciliation.reconcileAllPeriods();
    expect(summary.periods).toBe(1);
    expect(summary.balanced).toBe(1);
    expect(summary.unbalanced).toBe(0);

    const stale = db.prepare(
      "SELECT resolved FROM review_queue WHERE id = 'legacy-unbalanced-1'"
    ).get() as { resolved: number };
    expect(stale.resolved).toBe(1);

    const open = db.prepare(
      "SELECT COUNT(*) as count FROM review_queue WHERE reason = 'unbalanced_period' AND resolved = 0"
    ).get() as { count: number };
    expect(open.count).toBe(0);

    const again = reconciliation.reconcileAllPeriods();
    expect(again.balanced).toBe(1);
    const stillOpen = db.prepare(
      "SELECT COUNT(*) as count FROM review_queue WHERE reason = 'unbalanced_period' AND resolved = 0"
    ).get() as { count: number };
    expect(stillOpen.count).toBe(0);
  });

  it('falls back to the date window for posted lines with no statement document', async () => {
    await importService.import('ocbc-card-cycle-jan.txt', readFileSync(join(layouts, 'ocbc-card-cycle-jan.txt')));
    const period = db.prepare('SELECT * FROM statement_periods').get() as {
      id: string;
      account_id: string;
      start_date: number;
      end_date: number;
      opening_balance_cents: number;
      closing_balance_cents: number;
    };

    insertPostedTx(db, {
      accountId: period.account_id,
      amountCents: -200,
      timestamp: new Date(2026, 0, 12).getTime(),
      merchant: 'ALERT ONLY GRAB',
      observationIds: [],
    });

    const result = reconciliation.reconcilePeriod(period.id);
    expect(result.success).toBe(false);
    expect(result.discrepancyCents).toBe(-200);
    expect(result.transactionCount).toBe(2);
  });
});

describe('src/scripts/reconcile.ts CLI', () => {
  it('recomputes status for every period against DATABASE_PATH', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'reconcile-cli-'));
    const dbPath = join(tmpDir, 'openenvelope.db');
    const db = initDatabase(dbPath);
    try {
      db.prepare(`
        INSERT INTO accounts (id, name, aliases, account_group, created_at)
        VALUES ('acct', 'Test', '["acct"]', 'budget', ?)
      `).run(Date.now());
      db.prepare(`
        INSERT INTO raw_documents (hash, filename, mime_type, uploaded_at, size_bytes)
        VALUES ('doc-a', 'a.txt', 'text/plain', ?, 10)
      `).run(Date.now());
      const start = new Date(2026, 0, 1).getTime();
      const end = new Date(2026, 0, 31).getTime();
      db.prepare(`
        INSERT INTO statement_periods (
          id, account_id, start_date, end_date,
          opening_balance_cents, closing_balance_cents,
          document_hash, status, discrepancy_cents, created_at
        ) VALUES ('p1', 'acct', ?, ?, 10000, 10000, 'doc-a', 'unbalanced', 99, ?)
      `).run(start, end, Date.now());
      db.prepare(`
        INSERT INTO review_queue (id, observation_id, document_hash, reason, detail, created_at)
        VALUES ('legacy-p1', NULL, 'doc-a', 'unbalanced_period', ?, ?)
      `).run(JSON.stringify({ periodId: 'p1', discrepancyCents: 99 }), Date.now());
      db.close();

      const tsx = join(process.cwd(), 'node_modules/.bin/tsx');
      const output = execFileSync(tsx, ['src/scripts/reconcile.ts'], {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_PATH: dbPath },
        encoding: 'utf8',
      });
      const summary = JSON.parse(output) as {
        periods: number;
        balanced: number;
        unbalanced: number;
        reviewsResolved: number;
      };
      expect(summary.periods).toBe(1);
      expect(summary.balanced).toBe(1);
      expect(summary.unbalanced).toBe(0);
      expect(summary.reviewsResolved).toBeGreaterThanOrEqual(1);

      const verify = initDatabase(dbPath);
      const period = verify.prepare('SELECT status, discrepancy_cents FROM statement_periods WHERE id = ?').get('p1') as {
        status: string;
        discrepancy_cents: number;
      };
      expect(period.status).toBe('balanced');
      expect(period.discrepancy_cents).toBe(0);
      const review = verify.prepare("SELECT resolved FROM review_queue WHERE id = 'legacy-p1'").get() as {
        resolved: number;
      };
      expect(review.resolved).toBe(1);
      verify.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
