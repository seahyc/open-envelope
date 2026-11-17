import type Database from 'better-sqlite3';
import { meaningfulTokens, normalizeMerchantKey, shortMerchantKey, wordBoundaryMatch } from './normalize.js';
import { hh } from '../lib/tenancy.js';

export interface MemoryHit {
  merchantKey: string;
  categoryId: string;
  count: number;
  total: number;
  agreement: number;
  flagAsk: boolean;
  match: 'exact' | 'short-key' | 'word-boundary';
}

export interface MemoryCounts {
  merchantKey: string;
  categoryId: string;
  count: number;
  flagAsk: boolean;
}

const HIGH_AGREEMENT = 0.8;
export const MIN_MEMORY_COUNT = 3;

export function memoryConfidence(hit: Pick<MemoryHit, 'agreement' | 'total'>): number {
  return hit.agreement * Math.min(1, hit.total / MIN_MEMORY_COUNT);
}

export class MerchantMemory {
  constructor(private db: Database.Database) {}

  clear(): void {
    this.db.prepare('DELETE FROM merchant_memory WHERE household_id = ?').run(hh());
  }

  add(merchant: string, categoryId: string, count = 1, flagAsk = false): void {
    const key = normalizeMerchantKey(merchant);
    if (!key) return;
    this.db.prepare(`
      INSERT INTO merchant_memory (household_id, merchant_key, category_id, count, flag_ask)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(household_id, merchant_key, category_id) DO UPDATE SET
        count = count + excluded.count,
        flag_ask = MAX(flag_ask, excluded.flag_ask)
    `).run(hh(), key, categoryId, count, flagAsk ? 1 : 0);
  }

  ingestCsv(rows: Array<Record<string, string>>): void {
    for (const row of rows) {
      this.add(row.merchant_key ?? '', row.category_id ?? '', Number(row.count ?? 1), truthy(row.flag_ask));
    }
  }

  seedCsv(rows: Array<Record<string, string>>): void {
    for (const row of rows) {
      const key = normalizeMerchantKey(row.merchant_key ?? '');
      if (!key) continue;
      this.db.prepare(`
        INSERT INTO merchant_memory (household_id, merchant_key, category_id, count, flag_ask)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(household_id, merchant_key, category_id) DO UPDATE SET
          count = excluded.count,
          flag_ask = excluded.flag_ask
      `).run(hh(), key, row.category_id ?? '', Number(row.count ?? 1), truthy(row.flag_ask) ? 1 : 0);
    }
  }

  rebuildFromTransactions(): void {
    const rows = this.db.prepare(`
      SELECT merchant_text, normalized_merchant, category
      FROM transactions
      WHERE household_id = ? AND category IS NOT NULL AND category != ''
    `).all(hh()) as Array<{ merchant_text: string; normalized_merchant: string | null; category: string }>;
    for (const row of rows) {
      this.add(row.normalized_merchant || row.merchant_text, row.category, 1, row.category === 'flag');
    }
  }

  lookup(merchant: string): MemoryHit | null {
    const normalized = normalizeMerchantKey(merchant);
    if (!normalized) return null;
    const exact = this.bestForKey(normalized, 'exact');
    if (exact) return exact;
    const tokens = meaningfulTokens(normalized);
    for (const token of tokens) {
      const shortHit = this.bestForKey(token, 'short-key');
      if (shortHit) return shortHit;
    }
    const rows = this.db.prepare('SELECT DISTINCT merchant_key FROM merchant_memory WHERE household_id = ?').all(hh()) as Array<{ merchant_key: string }>;
    for (const row of rows) {
      const keyShort = shortMerchantKey(row.merchant_key);
      if (
        wordBoundaryMatch(normalized, row.merchant_key) ||
        (keyShort && wordBoundaryMatch(normalized, keyShort)) ||
        tokens.some((token) => wordBoundaryMatch(row.merchant_key, token))
      ) {
        const hit = this.bestForKey(row.merchant_key, 'word-boundary');
        if (hit) return hit;
      }
    }
    return null;
  }

  digest(merchant: string): string | null {
    const hit = this.lookup(merchant);
    const key = hit?.merchantKey ?? normalizeMerchantKey(merchant);
    const rows = this.countsFor(key);
    if (rows.length === 0) return null;
    const parts = rows
      .sort((a, b) => b.count - a.count)
      .map((row) => `${row.count}× ${row.categoryId}`);
    return `${key}: ${parts.join(', ')}`;
  }

  relatedDigests(merchant: string, limit = 4): string[] {
    const normalized = normalizeMerchantKey(merchant);
    const keys = new Set<string>();
    const primary = this.lookup(merchant);
    if (primary) keys.add(primary.merchantKey);
    const all = this.db.prepare('SELECT DISTINCT merchant_key FROM merchant_memory WHERE household_id = ?').all(hh()) as Array<{ merchant_key: string }>;
    for (const row of all) {
      if (wordBoundaryMatch(normalized, row.merchant_key) || wordBoundaryMatch(row.merchant_key, shortMerchantKey(normalized))) {
        keys.add(row.merchant_key);
      }
    }
    return [...keys]
      .map((key) => this.digest(key))
      .filter((line): line is string => Boolean(line))
      .slice(0, limit);
  }

  highAgreement(hit: MemoryHit): boolean {
    return !hit.flagAsk && hit.total >= MIN_MEMORY_COUNT && hit.agreement >= HIGH_AGREEMENT;
  }

  canAutoApply(hit: MemoryHit): boolean {
    return this.highAgreement(hit) && (hit.match === 'exact' || hit.match === 'short-key');
  }

  confidence(hit: MemoryHit): number {
    return memoryConfidence(hit);
  }

  private bestForKey(key: string, match: MemoryHit['match']): MemoryHit | null {
    const rows = this.countsFor(key);
    if (rows.length === 0) return null;
    const total = rows.reduce((sum, row) => sum + row.count, 0);
    const top = rows.slice().sort((a, b) => b.count - a.count)[0]!;
    return {
      merchantKey: key,
      categoryId: top.categoryId,
      count: top.count,
      total,
      agreement: total === 0 ? 0 : top.count / total,
      flagAsk: rows.some((row) => row.flagAsk),
      match,
    };
  }

  private countsFor(key: string): MemoryCounts[] {
    return this.db.prepare(
      'SELECT merchant_key as merchantKey, category_id as categoryId, count, flag_ask as flagAsk FROM merchant_memory WHERE household_id = ? AND merchant_key = ?'
    ).all(hh(), key) as MemoryCounts[];
  }
}

function truthy(value: string | number | undefined): boolean {
  if (value === undefined) return false;
  return value === 1 || value === '1' || value === 'true' || value === 'yes';
}
