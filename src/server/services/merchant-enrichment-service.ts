import type Database from 'better-sqlite3';
import { logger } from '../lib/logger.js';
import { MerchantMemory } from '../categoriser/memory.js';
import { normalizeMerchantKey } from '../categoriser/normalize.js';
import { hh } from '../lib/tenancy.js';
import { parsePayeeAndUen } from './payee-parse.js';
import { opengovsgCorporateUrl, titleCaseName } from './display-name.js';
import { ssicDescriptionFor } from './ssic-guess.js';
import { executeCodex } from '../lib/llm-provider-codex.js';
import { DEFAULT_CODEX_BIN, DEFAULT_CODEX_MODEL, DEFAULT_CODEX_REASONING_EFFORT } from '../lib/codex-defaults.js';

export type EnrichmentSource = 'acra' | 'web';

export interface EnrichmentQuery {
  payeeName: string;
  uen: string | null;
}

export interface MerchantEnrichment {
  merchantKey: string;
  payeeName: string;
  uen: string | null;
  source: EnrichmentSource;
  registeredName: string | null;
  entityStatus: string | null;
  ssicCode: string | null;
  ssicDescription: string | null;
  registeredAddress: string | null;
  incorporationDate: string | null;
  webDescription: string | null;
  sourceUrls: string[];
  fetchedAt: number;
}

export interface AcraRecord {
  uen: string;
  entityName: string;
  entityStatus: string | null;
  ssicCode: string | null;
  ssicDescription: string | null;
  registeredAddress: string | null;
  incorporationDate: string | null;
  sourceUrl: string | null;
}

export interface WebLookupResult {
  description: string;
  sourceUrls: string[];
}

export interface AcraLookup {
  lookupByUen(uen: string): Promise<AcraRecord | null>;
  lookupByName(name: string): Promise<AcraRecord | null>;
}

export interface WebLookup {
  lookup(name: string): Promise<WebLookupResult | null>;
}

export function parseEnrichmentModes(raw = process.env.MERCHANT_ENRICHMENT): Set<EnrichmentSource> {
  const value = (raw ?? 'acra').trim().toLowerCase();
  if (!value || value === 'off' || value === 'none') return new Set();
  const modes = new Set<EnrichmentSource>();
  for (const part of value.split(',')) {
    const token = part.trim();
    if (token === 'acra' || token === 'web') modes.add(token);
  }
  return modes;
}

export function formatEnrichmentLine(row: MerchantEnrichment): string {
  if (row.source === 'acra' && row.registeredName) {
    const ssicDesc = blankAcraText(row.ssicDescription);
    const ssic = row.ssicCode
      ? `SSIC ${row.ssicCode}${ssicDesc ? ` ${ssicDesc}` : ''}`
      : null;
    return `ACRA: ${row.registeredName}${ssic ? ` — ${ssic}` : ''}`;
  }
  if (row.webDescription) return `Web: ${row.webDescription}`;
  return row.source === 'acra' ? 'ACRA: no match' : 'Web: no match';
}

export function readCachedEnrichment(db: Database.Database, merchantText: string): MerchantEnrichment | null {
  const key = normalizeMerchantKey(merchantText);
  if (!key) return null;
  const row = db.prepare('SELECT * FROM merchant_enrichments WHERE merchant_key = ?').get(key) as
    | EnrichmentRow
    | undefined;
  return row ? fromRow(row) : null;
}

export function hasMemoryOrRuleMatch(db: Database.Database, merchantText: string): boolean {
  const memory = new MerchantMemory(db);
  if (memory.lookup(merchantText)) return true;
  const rules = db.prepare('SELECT pattern FROM merchant_rules WHERE household_id = ?').all(hh()) as Array<{ pattern: string }>;
  const haystack = merchantText.toUpperCase();
  const key = normalizeMerchantKey(merchantText);
  for (const rule of rules) {
    const pattern = rule.pattern.trim();
    if (!pattern) continue;
    if (haystack.includes(pattern.toUpperCase())) return true;
    const patternKey = normalizeMerchantKey(pattern);
    if (patternKey && (key === patternKey || key.includes(patternKey))) return true;
  }
  return false;
}

export function webLookupPrompt(name: string): string {
  return `What kind of business is ${name}, Singapore? Reply with a short description and source URLs. Use only the business name. Do not use amounts, dates, or account numbers.`;
}

export class MerchantEnrichmentService {
  private lastCallAt = 0;

  constructor(
    private db: Database.Database,
    private modes: Set<EnrichmentSource>,
    private acra: AcraLookup,
    private web: WebLookup,
    private minIntervalMs = 200,
    private now: () => number = () => Date.now(),
  ) {}

  get(merchantKey: string): MerchantEnrichment | null {
    const row = this.db.prepare('SELECT * FROM merchant_enrichments WHERE merchant_key = ?').get(merchantKey) as
      | EnrichmentRow
      | undefined;
    return row ? fromRow(row) : null;
  }

  getForMerchantText(merchantText: string): MerchantEnrichment | null {
    const key = normalizeMerchantKey(merchantText);
    if (!key) return null;
    return this.get(key);
  }

  async enrichMerchantText(merchantText: string, options: { refresh?: boolean } = {}): Promise<MerchantEnrichment | null> {
    const parsed = parsePayeeAndUen(merchantText);
    const key = normalizeMerchantKey(merchantText);
    if (!key) return null;
    const query: EnrichmentQuery = { payeeName: parsed.payeeName, uen: parsed.uen };
    return this.enrich(key, query, options);
  }

  async enrich(merchantKey: string, query: EnrichmentQuery, options: { refresh?: boolean } = {}): Promise<MerchantEnrichment | null> {
    if (this.modes.size === 0) return null;
    if (!options.refresh) {
      const cached = this.get(merchantKey);
      if (cached) return cached;
    }
    try {
      await this.throttle();
      if (this.modes.has('acra')) {
        const acra = query.uen
          ? await this.acra.lookupByUen(query.uen)
          : await this.acra.lookupByName(query.payeeName);
        if (acra) {
          const row: MerchantEnrichment = {
            merchantKey,
            payeeName: query.payeeName,
            uen: acra.uen || query.uen,
            source: 'acra',
            registeredName: acra.entityName,
            entityStatus: acra.entityStatus,
            ssicCode: acra.ssicCode,
            ssicDescription: acra.ssicDescription,
            registeredAddress: acra.registeredAddress,
            incorporationDate: acra.incorporationDate,
            webDescription: null,
            sourceUrls: acra.sourceUrl ? [acra.sourceUrl] : [],
            fetchedAt: this.now(),
          };
          this.save(row);
          return row;
        }
      }
      if (this.modes.has('web')) {
        const web = await this.web.lookup(query.payeeName);
        if (web) {
          const row: MerchantEnrichment = {
            merchantKey,
            payeeName: query.payeeName,
            uen: query.uen,
            source: 'web',
            registeredName: null,
            entityStatus: null,
            ssicCode: null,
            ssicDescription: null,
            registeredAddress: null,
            incorporationDate: null,
            webDescription: web.description,
            sourceUrls: web.sourceUrls,
            fetchedAt: this.now(),
          };
          this.save(row);
          return row;
        }
      }
    } catch (error) {
      logger.warn('Merchant enrichment failed', {
        merchantKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }

  private save(row: MerchantEnrichment): void {
    this.db.prepare(`
      INSERT INTO merchant_enrichments (
        merchant_key, payee_name, uen, source, registered_name, entity_status,
        ssic_code, ssic_description, registered_address, incorporation_date,
        web_description, source_urls, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(merchant_key) DO UPDATE SET
        payee_name = excluded.payee_name,
        uen = excluded.uen,
        source = excluded.source,
        registered_name = excluded.registered_name,
        entity_status = excluded.entity_status,
        ssic_code = excluded.ssic_code,
        ssic_description = excluded.ssic_description,
        registered_address = excluded.registered_address,
        incorporation_date = excluded.incorporation_date,
        web_description = excluded.web_description,
        source_urls = excluded.source_urls,
        fetched_at = excluded.fetched_at
    `).run(
      row.merchantKey,
      row.payeeName,
      row.uen,
      row.source,
      row.registeredName,
      row.entityStatus,
      row.ssicCode,
      row.ssicDescription,
      row.registeredAddress,
      row.incorporationDate,
      row.webDescription,
      JSON.stringify(row.sourceUrls),
      row.fetchedAt,
    );
  }

  private async throttle(): Promise<void> {
    const wait = this.minIntervalMs - (this.now() - this.lastCallAt);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastCallAt = this.now();
  }
}

interface EnrichmentRow {
  merchant_key: string;
  payee_name: string;
  uen: string | null;
  source: string;
  registered_name: string | null;
  entity_status: string | null;
  ssic_code: string | null;
  ssic_description: string | null;
  registered_address: string | null;
  incorporation_date: string | null;
  web_description: string | null;
  source_urls: string | null;
  fetched_at: number;
}

function fromRow(row: EnrichmentRow): MerchantEnrichment {
  let urls: string[] = [];
  try {
    const parsed = row.source_urls ? JSON.parse(row.source_urls) : [];
    if (Array.isArray(parsed)) urls = parsed.map(String);
  } catch {
    urls = [];
  }
  return {
    merchantKey: row.merchant_key,
    payeeName: row.payee_name,
    uen: row.uen,
    source: row.source === 'web' ? 'web' : 'acra',
    registeredName: row.registered_name,
    entityStatus: row.entity_status,
    ssicCode: row.ssic_code,
    ssicDescription: row.ssic_description,
    registeredAddress: row.registered_address ?? null,
    incorporationDate: row.incorporation_date ?? null,
    webDescription: row.web_description,
    sourceUrls: urls,
    fetchedAt: row.fetched_at,
  };
}

interface DatastoreRecord {
  uen?: string;
  entity_name?: string;
  uen_status_desc?: string;
  entity_status_description?: string;
  primary_ssic_code?: string;
  primary_ssic_description?: string;
  registration_incorporation_date?: string;
  uen_issue_date?: string;
  block?: string;
  street_name?: string;
  level_no?: string;
  unit_no?: string;
  building_name?: string;
  postal_code?: string;
  [key: string]: unknown;
}

const LEGAL_SUFFIX = new Set(['PTE', 'LTD', 'LIMITED', 'PRIVATE', 'LLP', 'LLC', 'CO', 'COMPANY', 'INC']);

export const ACRA_UEN_RESOURCE_ID = 'd_3f960c10fed6145404ca7b821f263b87';

export const ACRA_LETTER_RESOURCES: Record<string, string> = {
  A: 'd_8575e84912df3c28995b8e6e0e05205a',
  B: 'd_3a3807c023c61ddfba947dc069eb53f2',
  C: 'd_c0650f23e94c42e7a20921f4c5b75c24',
  D: 'd_acbc938ec77af18f94cecc4a7c9ec720',
  E: 'd_124a9bd407c7a25f8335b93b86e50fdd',
  F: 'd_4526d47d6714d3b052eed4a30b8b1ed6',
  G: 'd_b58303c68e9cf0d2ae93b73ffdbfbfa1',
  H: 'd_fa2ed456cf2b8597bb7e064b08fc3c7c',
  I: 'd_85518d970b8178975850457f60f1e738',
  J: 'd_478f45a9c541cbe679ca55d1cd2b970b',
  K: 'd_5573b0db0575db32190a2ad27919a7aa',
  L: 'd_a2141adf93ec2a3c2ec2837b78d6d46e',
  M: 'd_9af9317c646a1c881bb5591c91817cc6',
  N: 'd_67e99e6eabc4aad9b5d48663b579746a',
  O: 'd_5c4ef48b025fdfbc80056401f06e3df9',
  P: 'd_181005ca270b45408b4cdfc954980ca2',
  Q: 'd_4130f1d9d365d9f1633536e959f62bb7',
  R: 'd_2b8c54b2a490d2fa36b925289e5d9572',
  S: 'd_df7d2d661c0c11a7c367c9ee4bf896c1',
  T: 'd_72f37e5c5d192951ddc5513c2b134482',
  U: 'd_0cc5f52a1f298b916f317800251057f3',
  V: 'd_e97e8e7fc55b85a38babf66b0fa46b73',
  W: 'd_af2042c77ffaf0db5d75561ce9ef5688',
  X: 'd_1cd970d8351b42be4a308d628a6dd9d3',
  Y: 'd_31af23fdb79119ed185c256f03cb5773',
  Z: 'd_4e3db8955fdcda6f9944097bef3d2724',
  OTHERS: 'd_300ddc8da4e8f7bdc1bfc62d0d99e2e7',
};

export function blankAcraText(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'na' || trimmed === '-') return null;
  return trimmed;
}

export function acraResourceForName(name: string): string {
  const first = name.trim().charAt(0).toUpperCase();
  if (first >= 'A' && first <= 'Z') return ACRA_LETTER_RESOURCES[first] ?? ACRA_LETTER_RESOURCES.OTHERS!;
  return ACRA_LETTER_RESOURCES.OTHERS!;
}

export function acraNameQueries(name: string): string[] {
  const tokens = name.trim().toUpperCase().split(/\s+/).filter(Boolean);
  const queries = [tokens.join(' ')];
  const last = tokens[tokens.length - 1] ?? '';
  if (tokens.length >= 2 && last.length >= 5 && !LEGAL_SUFFIX.has(last)) {
    queries.push(tokens.slice(0, -1).join(' '));
  }
  return [...new Set(queries.filter(Boolean))];
}

export function scoreAcraName(query: string, entityName: string, status: string | null): number {
  const q = normalizeAcraName(query);
  const n = normalizeAcraName(entityName);
  if (!q || !n) return 0;
  if (n === q) return 1000;
  if (n.startsWith(`${q} `) || n.startsWith(q)) return 900 + Math.min(q.length, 80);
  const qt = q.split(' ');
  const nt = n.split(' ');
  let matched = 0;
  while (matched < qt.length && matched < nt.length) {
    const qTok = qt[matched]!;
    const nTok = nt[matched]!;
    if (qTok === nTok) {
      matched += 1;
      continue;
    }
    if (nTok.startsWith(qTok) && qTok.length >= 4) {
      matched += 1;
      break;
    }
    break;
  }
  if (matched === 0 || matched < qt.length) return 0;
  let score = matched * 120 + Math.min(q.length, n.length) + 220;
  if (/live/i.test(status ?? '')) score += 40;
  return score;
}

export function pickAcraRecord(query: string, records: DatastoreRecord[]): DatastoreRecord | null {
  let best: { record: DatastoreRecord; score: number } | null = null;
  for (const record of records) {
    const entityName = String(record.entity_name ?? '').trim();
    if (!entityName) continue;
    const status = record.uen_status_desc
      ? String(record.uen_status_desc)
      : record.entity_status_description
        ? String(record.entity_status_description)
        : null;
    const score = scoreAcraName(query, entityName, status);
    if (score < 250) continue;
    if (!best || score > best.score) best = { record, score };
  }
  return best?.record ?? null;
}

function normalizeAcraName(name: string): string {
  return name
    .toUpperCase()
    .replace(/\b(PTE\.?|LTD\.?|LIMITED|PRIVATE|LLP|LLC|INC\.?)\b/g, ' ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function datasetUrl(resourceId: string): string {
  return `https://data.gov.sg/datasets/${resourceId}/view`;
}

export function formatAcraAddress(record: DatastoreRecord): string | null {
  const block = blankAcraText(record.block ? String(record.block) : null);
  const street = blankAcraText(record.street_name ? String(record.street_name) : null);
  const level = blankAcraText(record.level_no ? String(record.level_no) : null);
  const unit = blankAcraText(record.unit_no ? String(record.unit_no) : null);
  const building = blankAcraText(record.building_name ? String(record.building_name) : null);
  const postal = blankAcraText(record.postal_code ? String(record.postal_code) : null);
  if (!block && !street) return null;
  const floor = level && unit ? `#${level}-${unit}` : unit ? `#${unit}` : '';
  const postalBit = postal ? `S(${postal})` : '';
  const streetName = street ? titleCaseName(street) : '';
  return [block, streetName, building ? titleCaseName(building) : null, floor, postalBit]
    .filter(Boolean)
    .join(' ');
}

function acraDate(record: DatastoreRecord): string | null {
  return blankAcraText(record.registration_incorporation_date ? String(record.registration_incorporation_date) : null)
    ?? blankAcraText(record.uen_issue_date ? String(record.uen_issue_date) : null);
}

function toAcraRecord(record: DatastoreRecord, resourceId: string): AcraRecord | null {
  const entityName = String(record.entity_name ?? '').trim();
  if (!entityName) return null;
  const uen = String(record.uen ?? '').trim();
  const ssicCode = blankAcraText(record.primary_ssic_code ? String(record.primary_ssic_code) : null);
  return {
    uen,
    entityName,
    entityStatus: blankAcraText(
      record.uen_status_desc ? String(record.uen_status_desc) : record.entity_status_description ? String(record.entity_status_description) : null
    ),
    ssicCode,
    ssicDescription: ssicDescriptionFor(
      ssicCode,
      blankAcraText(record.primary_ssic_description ? String(record.primary_ssic_description) : null)
    ),
    registeredAddress: formatAcraAddress(record),
    incorporationDate: acraDate(record),
    sourceUrl: uen ? opengovsgCorporateUrl(uen) : datasetUrl(resourceId),
  };
}

export function createAcraLookup(options: {
  resourceId?: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  letterResources?: Record<string, string>;
  uenResourceId?: string;
} = {}): AcraLookup {
  const singleResource = options.resourceId || process.env.ACRA_RESOURCE_ID || '';
  const endpoint = options.endpoint || process.env.ACRA_DATASTORE_URL || 'https://data.gov.sg/api/action/datastore_search';
  const fetchImpl = options.fetchImpl ?? fetch;
  const letters = options.letterResources ?? ACRA_LETTER_RESOURCES;
  const uenResource = options.uenResourceId || process.env.ACRA_UEN_RESOURCE_ID || ACRA_UEN_RESOURCE_ID;

  function resourceForName(name: string): string {
    if (singleResource) return singleResource;
    const first = name.trim().charAt(0).toUpperCase();
    if (first >= 'A' && first <= 'Z') return letters[first] ?? letters.OTHERS ?? ACRA_LETTER_RESOURCES.OTHERS!;
    return letters.OTHERS ?? ACRA_LETTER_RESOURCES.OTHERS!;
  }

  async function search(resourceId: string, params: Record<string, string>, limit = 12): Promise<DatastoreRecord[]> {
    const url = new URL(endpoint);
    url.searchParams.set('resource_id', resourceId);
    url.searchParams.set('limit', String(limit));
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await fetchImpl(url.toString(), { signal: AbortSignal.timeout(4000) });
    if (!response.ok) return [];
    const body = await response.json() as { result?: { records?: DatastoreRecord[] } };
    return body.result?.records ?? [];
  }

  async function lookupUenOn(resourceId: string, uen: string): Promise<AcraRecord | null> {
    const records = await search(resourceId, { filters: JSON.stringify({ uen }) }, 5);
    const record = records[0];
    return record ? toAcraRecord(record, resourceId) : null;
  }

  return {
    async lookupByUen(uen: string) {
      if (singleResource) return lookupUenOn(singleResource, uen);
      const combined = await lookupUenOn(uenResource, uen);
      if (combined?.ssicCode) return combined;
      const letterId = combined?.entityName ? resourceForName(combined.entityName) : '';
      if (letterId) {
        const detailed = await lookupUenOn(letterId, uen);
        if (detailed) return detailed;
      }
      return combined;
    },
    async lookupByName(name: string) {
      const resourceId = resourceForName(name);
      for (const query of acraNameQueries(name)) {
        const records = await search(resourceId, { q: JSON.stringify({ entity_name: query }) });
        const record = pickAcraRecord(name, records) ?? (singleResource ? records[0] ?? null : null);
        if (!record) continue;
        const mapped = toAcraRecord(record, resourceId);
        if (mapped) return mapped;
      }
      return null;
    },
  };
}

export function createWebLookup(): WebLookup {
  return {
    async lookup(name: string) {
      const prompt = webLookupPrompt(name);
      const result = await executeCodex<{ description: string; sourceUrls: string[] }>(
        {
          codexBin: process.env.CODEX_BIN || DEFAULT_CODEX_BIN,
          codexHome: process.env.CODEX_HOME,
          codexModel: process.env.CODEX_MODEL || DEFAULT_CODEX_MODEL,
          codexReasoningEffort: process.env.CODEX_REASONING_EFFORT || DEFAULT_CODEX_REASONING_EFFORT,
          extraConfig: ['features.web_search_request=true'],
          timeout: Number(process.env.LLM_TIMEOUT || 30000),
        },
        prompt,
        {
          type: 'object',
          properties: {
            description: { type: 'string' },
            sourceUrls: { type: 'array', items: { type: 'string' } },
          },
          required: ['description', 'sourceUrls'],
        },
      );
      if (!result?.description) return null;
      return { description: result.description, sourceUrls: result.sourceUrls ?? [] };
    },
  };
}

export function enrichmentServiceFromEnv(db: Database.Database): MerchantEnrichmentService {
  const modes = parseEnrichmentModes();
  const skipNetwork = Boolean(process.env.VITEST);
  const acra: AcraLookup = skipNetwork
    ? { lookupByUen: async () => null, lookupByName: async () => null }
    : createAcraLookup();
  const web: WebLookup = skipNetwork
    ? { lookup: async () => null }
    : createWebLookup();
  return new MerchantEnrichmentService(db, modes, acra, web, skipNetwork ? 0 : 200);
}
