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

describe('detect-transfers import', () => {
  let tmpDir: string;
  let db: Database.Database;
  let importService: ImportService;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'detect-xfer-'));
    mkdirSync(join(tmpDir, 'documents'), { recursive: true });
    db = initDatabase(join(tmpDir, 'test.db'));
    db.prepare(`
      INSERT INTO accounts (id, name, aliases, account_group, created_at)
      VALUES
        ('ocbc-360-7777', 'OCBC 360 7777', '["501777777001"]', 'budget', ?),
        ('ocbc-card-7788', 'OCBC Card 7788', '["card-7788"]', 'credit', ?),
        ('ocbc-360-6666', 'OCBC 360 6666', '["501666666001"]', 'budget', ?),
        ('ocbc-sav-1111', 'OCBC Savings 1111', '["550111111002"]', 'budget', ?)
    `).run(Date.now(), Date.now(), Date.now(), Date.now());
    const documentStore = new LocalDocumentStore(join(tmpDir, 'documents'));
    const pipelineService = new PipelineService(db, null, [], documentStore);
    importService = new ImportService(db, documentStore, defaultRegistry, pipelineService);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('auto-links card bill payment from a bank account to the card credit', async () => {
    await importService.import('ocbc-360-card-bill.txt', readFileSync(join(layouts, 'ocbc-360-card-bill.txt')));
    await importService.import('ocbc-card-payment-credit.txt', readFileSync(join(layouts, 'ocbc-card-payment-credit.txt')));

    const bank = db.prepare(
      "SELECT id, linked_transaction_id, amount_cents FROM transactions WHERE merchant_text LIKE '%CARD PAYMENT%'"
    ).get() as { id: string; linked_transaction_id: string | null; amount_cents: number };
    const card = db.prepare(
      "SELECT id, linked_transaction_id, amount_cents FROM transactions WHERE merchant_text LIKE '%PAYMENT RECEIVED%'"
    ).get() as { id: string; linked_transaction_id: string | null; amount_cents: number };

    expect(bank.amount_cents).toBe(-20000);
    expect(card.amount_cents).toBe(20000);
    expect(bank.linked_transaction_id).toBe(card.id);
    expect(card.linked_transaction_id).toBe(bank.id);

    const periods = db.prepare('SELECT status FROM statement_periods').all() as Array<{ status: string }>;
    expect(periods.every((period) => period.status === 'balanced')).toBe(true);
  });

  it('auto-links own-account FAST/PayNow between two known accounts', async () => {
    await importService.import('ocbc-360-paynow-out.txt', readFileSync(join(layouts, 'ocbc-360-paynow-out.txt')));
    await importService.import('ocbc-savings-paynow-in.txt', readFileSync(join(layouts, 'ocbc-savings-paynow-in.txt')));

    const out = db.prepare(
      "SELECT id, linked_transaction_id FROM transactions WHERE account_id = 'ocbc-360-6666'"
    ).get() as { id: string; linked_transaction_id: string | null };
    const inn = db.prepare(
      "SELECT id, linked_transaction_id FROM transactions WHERE account_id = 'ocbc-sav-1111'"
    ).get() as { id: string; linked_transaction_id: string | null };

    expect(out.linked_transaction_id).toBe(inn.id);
    expect(inn.linked_transaction_id).toBe(out.id);
  });
});
