import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/server/db/migrations.js';
import { normalizeMerchantKey } from '../../src/server/categoriser/normalize.js';
import { MerchantMemory } from '../../src/server/categoriser/memory.js';
import { formatFacts } from '../../src/server/categoriser/prompt.js';
import {
  ACRA_LETTER_RESOURCES,
  MerchantEnrichmentService,
  acraNameQueries,
  acraResourceForName,
  createAcraLookup,
  formatEnrichmentLine,
  hasMemoryOrRuleMatch,
  parseEnrichmentModes,
  pickAcraRecord,
  scoreAcraName,
  webLookupPrompt,
  type AcraLookup,
  type WebLookup,
} from '../../src/server/services/merchant-enrichment-service.js';

const PAYNOW = 'FAST PAYMENT via PayNow-UEN to ABOVE ALL ENTERP OTHR-OTHR';
const UEN_LINE = 'FAST PAYMENT via PayNow-UEN 201234567A to CAFE ABC OTHR-OTHR';

function service(
  db: Database.Database,
  acra: AcraLookup,
  web: WebLookup,
  modes = new Set<'acra' | 'web'>(['acra'])
) {
  return new MerchantEnrichmentService(db, modes, acra, web, 0);
}

describe('merchant enrichment', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, { quiet: true });
  });

  it('defaults the feature flag to ACRA only', () => {
    expect([...parseEnrichmentModes(undefined)]).toEqual(['acra']);
    expect([...parseEnrichmentModes('acra,web')].sort()).toEqual(['acra', 'web']);
    expect(parseEnrichmentModes('off').size).toBe(0);
  });

  it('looks up by UEN, caches forever, and never sends amounts or account numbers', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain('201234567A');
      expect(url).not.toMatch(/1850|amount|account|2026/i);
      return {
        ok: true,
        json: async () => ({
          result: {
            records: [{
              uen: '201234567A',
              entity_name: 'CAFE ABC PTE. LTD.',
              uen_status_desc: 'Live Company',
              primary_ssic_code: '56112',
              primary_ssic_description: 'Cafes',
            }],
          },
        }),
      } as Response;
    });
    const acra = createAcraLookup({ fetchImpl });
    const web: WebLookup = { lookup: vi.fn(async () => { throw new Error('web should not run'); }) };
    const enrich = service(db, acra, web);
    const first = await enrich.enrichMerchantText(UEN_LINE);
    expect(first?.registeredName).toBe('CAFE ABC PTE. LTD.');
    expect(first?.source).toBe('acra');
    expect(formatEnrichmentLine(first!)).toBe('ACRA: CAFE ABC PTE. LTD. — SSIC 56112 Cafes');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const second = await enrich.enrichMerchantText(UEN_LINE);
    expect(second?.fetchedAt).toBe(first?.fetchedAt);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falls back to web search with only the payee name when ACRA misses', async () => {
    const acra: AcraLookup = {
      lookupByUen: async () => null,
      lookupByName: async () => null,
    };
    const web: WebLookup = {
      lookup: vi.fn(async (name) => {
        expect(name).toBe('ABOVE ALL ENTERP');
        expect(name).not.toMatch(/1850|OTHR/);
        return {
          description: 'Cafe operator in Singapore',
          sourceUrls: ['https://example.com/cafe'],
        };
      }),
    };
    const enrich = service(db, acra, web, new Set(['acra', 'web']));
    const row = await enrich.enrichMerchantText(PAYNOW);
    expect(row?.source).toBe('web');
    expect(formatEnrichmentLine(row!)).toBe('Web: Cafe operator in Singapore');
    expect(web.lookup).toHaveBeenCalledTimes(1);
  });

  it('skips lookup when merchant memory or a rule already matches', () => {
    const memory = new MerchantMemory(db);
    memory.add('FairMart', 'exp.food.groceries', 5, false);
    expect(hasMemoryOrRuleMatch(db, 'FairMart')).toBe(true);
    expect(hasMemoryOrRuleMatch(db, PAYNOW)).toBe(false);
    db.prepare(`
      INSERT INTO merchant_rules (id, pattern, category, envelope_id, created_at)
      VALUES ('rule-1', 'ABOVE ALL ENTERP', 'exp.food.dining.hawker', NULL, ?)
    `).run(Date.now());
    expect(hasMemoryOrRuleMatch(db, PAYNOW)).toBe(true);
  });

  it('treats lookup failures as non-fatal', async () => {
    const acra: AcraLookup = {
      lookupByUen: async () => { throw new Error('acra down'); },
      lookupByName: async () => { throw new Error('acra down'); },
    };
    const enrich = service(db, acra, { lookup: async () => null });
    await expect(enrich.enrichMerchantText(PAYNOW)).resolves.toBeNull();
  });

  it('keeps web-search prompts free of transaction details', () => {
    const prompt = webLookupPrompt('ABOVE ALL ENTERP');
    expect(prompt).toContain('ABOVE ALL ENTERP');
    expect(prompt).toContain('Do not use amounts, dates, or account numbers');
    expect(prompt).not.toMatch(/S\$|-1850|uiseed|account_id/i);
  });

  it('scores truncated PayNow names onto the live ACRA entity and ignores loose ALL hits', () => {
    expect(acraResourceForName('ABOVE ALL ENTERP')).toBe(ACRA_LETTER_RESOURCES.A);
    expect(acraNameQueries('ABOVE ALL ENTERP')).toEqual(['ABOVE ALL ENTERP', 'ABOVE ALL']);
    expect(scoreAcraName('ABOVE ALL ENTERP', 'ABOVE ALL ENTERPRISE PTE. LTD.', 'Live Company'))
      .toBeGreaterThan(scoreAcraName('ABOVE ALL ENTERP', 'ABOVE ALL SERVICES PTE. LTD.', 'Live Company'));
    const picked = pickAcraRecord('ABOVE ALL ENTERP', [
      { entity_name: 'ALL SHIPS SUPPLY & TRADING COMPANY', entity_status_description: 'Terminated', primary_ssic_code: '46100' },
      { entity_name: 'ABOVE ALL SERVICES PTE. LTD.', entity_status_description: 'Struck Off', primary_ssic_code: '46900' },
      { entity_name: 'ABOVE ALL ENTERPRISE PTE. LTD.', entity_status_description: 'Live Company', primary_ssic_code: '56122' },
    ]);
    expect(picked?.entity_name).toBe('ABOVE ALL ENTERPRISE PTE. LTD.');
    expect(formatEnrichmentLine({
      merchantKey: 'x',
      payeeName: 'ABOVE ALL ENTERP',
      uen: null,
      source: 'acra',
      registeredName: 'ABOVE ALL ENTERPRISE PTE. LTD.',
      entityStatus: 'Live Company',
      ssicCode: '56122',
      ssicDescription: 'na',
      registeredAddress: null,
      incorporationDate: null,
      webDescription: null,
      sourceUrls: [],
      fetchedAt: 1,
    })).toBe('ACRA: ABOVE ALL ENTERPRISE PTE. LTD. — SSIC 56122');
  });

  it('queries the lettered ACRA dataset with a field search, not the first Solr hit', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain(ACRA_LETTER_RESOURCES.A);
      expect(url).toContain('entity_name');
      expect(url).not.toMatch(/1850|OTHR|account/i);
      return {
        ok: true,
        json: async () => ({
          result: {
            records: [
              { entity_name: 'ALL SHIPS SUPPLY & TRADING COMPANY', entity_status_description: 'Terminated', primary_ssic_code: '46100', primary_ssic_description: 'na' },
              { uen: '202615975E', entity_name: 'ABOVE ALL ENTERPRISE PTE. LTD.', entity_status_description: 'Live Company', primary_ssic_code: '56122', primary_ssic_description: 'na', registration_incorporation_date: '2026-04-10', block: '206', street_name: 'SERANGOON CENTRAL', level_no: '04', unit_no: '158', postal_code: '550206' },
            ],
          },
        }),
      } as Response;
    });
    const acra = createAcraLookup({ fetchImpl });
    const web: WebLookup = { lookup: vi.fn(async () => { throw new Error('web should not run'); }) };
    const enrich = service(db, acra, web);
    const row = await enrich.enrichMerchantText(PAYNOW);
    expect(row?.registeredName).toBe('ABOVE ALL ENTERPRISE PTE. LTD.');
    expect(row?.ssicCode).toBe('56122');
    expect(row?.ssicDescription).toMatch(/coffee shop/i);
    expect(row?.uen).toBe('202615975E');
    expect(row?.registeredAddress).toBe('206 Serangoon Central #04-158 S(550206)');
    expect(row?.incorporationDate).toBe('2026-04-10');
    expect(row?.sourceUrls[0]).toBe('https://opengovsg.com/corporate/202615975E');
    expect(formatEnrichmentLine(row!)).toContain('ABOVE ALL ENTERPRISE PTE. LTD.');
  });

  it('passes the enrichment line into categoriser facts without extra lookup fields', () => {
    const facts = formatFacts({
      merchant: PAYNOW,
      accountId: 'uiseed-posb',
      amountCents: -1850,
      memo: null,
      enrichment: 'ACRA: ABOVE ALL ENTERPRISE — SSIC 56112 Cafes',
    });
    expect(facts).toContain('Enrichment: ACRA: ABOVE ALL ENTERPRISE — SSIC 56112 Cafes');
    expect(normalizeMerchantKey(PAYNOW)).toBe('ABOVE ALL ENTERP OTHR OTHR');
  });
});
