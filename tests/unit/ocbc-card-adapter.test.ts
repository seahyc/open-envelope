import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { OcbcCardAdapter } from '../../src/server/adapters/singapore/ocbc-card-adapter.js';
import { initDatabase } from '../../src/server/db/database.js';
import { LocalDocumentStore } from '../../src/server/storage/document-store.js';
import { ImportService } from '../../src/server/services/import-service.js';
import { PipelineService } from '../../src/server/services/pipeline-service.js';
import { defaultRegistry } from '../../src/server/adapters/registry.js';

const layouts = join(process.cwd(), 'fixtures/layouts');
const singapore = join(process.cwd(), 'fixtures/singapore');

describe('OcbcCardAdapter', () => {
  const adapter = new OcbcCardAdapter();

  it('still parses the legacy two-date fixture', async () => {
    const result = await adapter.parse(readFileSync(join(singapore, 'ocbc-card-statement.txt')));
    expect(result.observations).toHaveLength(7);
    expect(result.statementPeriod?.openingBalanceCents).toBe(-123450);
    expect(result.statementPeriod?.closingBalanceCents).toBe(-129590);
    const payment = result.observations.find((obs) => obs.merchantText.includes('PAYMENT'));
    expect(payment?.amountCents).toBe(50000);
  });

  it('parses 90°N rows with one date, bracket credits, FX, last-4 hint, and Dec→Jan years', async () => {
    const content = readFileSync(join(layouts, 'ocbc-card-90n.txt'));
    expect(await adapter.canParse(content, 'card.pdf', 'application/pdf')).toBeGreaterThan(0.5);

    const result = await adapter.parse(content);
    expect(result.observations).toHaveLength(7);
    expect(result.statementPeriod?.accountHint).toBe('card-9905');
    expect(result.statementPeriod?.openingBalanceCents).toBe(-100000);
    expect(result.statementPeriod?.closingBalanceCents).toBe(-97789);
    expect(result.statementPeriod?.startDate).toBeGreaterThan(0);
    expect(result.statementPeriod?.endDate).toBe(new Date(2026, 0, 25).getTime());

    const dec = result.observations.find((obs) => obs.merchantText.includes('DEC BOOKSTORE'));
    expect(dec?.amountCents).toBe(-5000);
    expect(dec?.timestamp).toBe(new Date(2025, 11, 28).getTime());

    const jan = result.observations.find((obs) => obs.merchantText.includes('JAN GROCER'));
    expect(jan?.timestamp).toBe(new Date(2026, 0, 5).getTime());

    const amazon = result.observations.find((obs) => obs.merchantText.includes('AMAZON'));
    expect(amazon?.amountCents).toBe(-9193);
    expect(amazon?.fxCurrency).toBe('USD');
    expect(amazon?.fxAmountCents).toBe(2500);

    const payment = result.observations.find((obs) => obs.merchantText.includes('PAYMENT'));
    expect(payment?.amountCents).toBe(20000);

    const grab = result.observations.find((obs) => obs.merchantText.includes('GRAB'));
    expect(grab?.amountCents).toBe(-850);
    expect(grab?.merchantText).toMatch(/PTE LTD/);

    const bus = result.observations.filter((obs) => obs.merchantText.includes('BUS/MRT'));
    expect(bus).toHaveLength(2);
    expect(bus.every((obs) => obs.amountCents === -123)).toBe(true);
    expect(result.observations.some((obs) => obs.merchantText.includes('ANNUAL FEE WAIVER'))).toBe(false);
    expect(result.observations.some((obs) => /Cardmember Agreement|credit limit|S\$/i.test(obs.merchantText))).toBe(false);
    expect(result.observations.some((obs) => obs.timestamp === new Date(2026, 2, 25).getTime())).toBe(false);
    expect(result.observations.some((obs) => obs.amountCents === -5000 && /CREDIT|MINIMUM/i.test(obs.merchantText))).toBe(false);

    const sum = result.observations.reduce((total, obs) => total + obs.amountCents, 0);
    expect(result.statementPeriod!.openingBalanceCents + sum).toBe(result.statementPeriod!.closingBalanceCents);
  });
});

describe('OcbcCardAdapter import identity', () => {
  let tmpDir: string;
  let db: Database.Database;
  let importService: ImportService;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ocbc-card-import-'));
    mkdirSync(join(tmpDir, 'documents'), { recursive: true });
    db = initDatabase(join(tmpDir, 'test.db'));
    db.prepare(`
      INSERT INTO accounts (id, name, aliases, account_group, created_at)
      VALUES ('ocbc-card', 'OCBC Card', '["card-9905"]', 'credit', ?)
    `).run(Date.now());
    const documentStore = new LocalDocumentStore(join(tmpDir, 'documents'));
    const pipelineService = new PipelineService(db, null, [], documentStore);
    importService = new ImportService(db, documentStore, defaultRegistry, pipelineService);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('keeps two identical statement lines and stays idempotent on re-import', async () => {
    const content = readFileSync(join(layouts, 'ocbc-card-90n.txt'));
    const first = await importService.import('ocbc-card-90n.txt', content);
    expect(first.observationsCreated).toBe(7);
    expect(first.hasStatementPeriod).toBe(true);
    const bus = db.prepare(
      "SELECT COUNT(*) as count FROM observations WHERE merchant_text LIKE '%BUS/MRT%'"
    ).get() as { count: number };
    expect(bus.count).toBe(2);

    const second = await importService.import('ocbc-card-90n.txt', content);
    expect(second.observationsCreated).toBe(0);
    expect(second.observationsDuplicate).toBe(0);
    const again = db.prepare('SELECT COUNT(*) as count FROM observations').get() as { count: number };
    expect(again.count).toBe(7);
  });
});
