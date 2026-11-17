import type Database from 'better-sqlite3';
import crypto from 'crypto';
import { amountBand, memoTokens, normalizeMerchantKey } from './normalize.js';

export interface LabelledExample {
  merchant: string;
  accountId?: string | null;
  amountCents: number;
  memo?: string | null;
  categoryId: string;
  source?: string;
}

export interface RetrievedExemplar {
  merchantKey: string;
  accountId: string | null;
  amountCents: number;
  memo: string;
  categoryId: string;
  score: number;
}

export class ExemplarStore {
  constructor(private db: Database.Database) {}

  add(example: LabelledExample): string {
    const id = crypto.randomBytes(8).toString('hex');
    const merchantKey = normalizeMerchantKey(example.merchant);
    const band = amountBand(example.amountCents);
    const memo = memoTokens(example.memo);
    this.db.prepare(`
      INSERT INTO category_exemplars (
        id, merchant_key, account_id, amount_cents, amount_band, memo, category_id, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      merchantKey,
      example.accountId ?? null,
      example.amountCents,
      band,
      memo,
      example.categoryId,
      example.source ?? 'label',
      Date.now()
    );
    this.indexFts(id, merchantKey, example.accountId ?? '', memo, band, example.categoryId);
    return id;
  }

  retrieveSimilar(query: LabelledExample, limit = 8): RetrievedExemplar[] {
    const merchantKey = normalizeMerchantKey(query.merchant);
    const band = amountBand(query.amountCents);
    const memo = memoTokens(query.memo);
    if (this.hasFts()) {
      const ftsQuery = [merchantKey, query.accountId ?? '', memo, band]
        .filter(Boolean)
        .map((part) => `"${part.replace(/"/g, '')}"`)
        .join(' OR ');
      if (ftsQuery) {
        const rows = this.db.prepare(`
          SELECT e.merchant_key as merchantKey, e.account_id as accountId, e.amount_cents as amountCents,
                 e.memo, e.category_id as categoryId, bm25(category_exemplars_fts) as score
          FROM category_exemplars_fts
          JOIN category_exemplars e ON e.id = category_exemplars_fts.exemplar_id
          WHERE category_exemplars_fts MATCH ?
          ORDER BY score
          LIMIT ?
        `).all(ftsQuery, limit) as RetrievedExemplar[];
        if (rows.length > 0) return rows;
      }
    }
    return this.trigramFallback(merchantKey, query.accountId ?? '', band, limit);
  }

  canonicalFor(categoryId: string): RetrievedExemplar | null {
    const row = this.db.prepare(`
      SELECT merchant_key as merchantKey, account_id as accountId, amount_cents as amountCents,
             memo, category_id as categoryId, 0 as score
      FROM category_exemplars
      WHERE category_id = ?
      ORDER BY created_at ASC
      LIMIT 1
    `).get(categoryId) as RetrievedExemplar | undefined;
    return row ?? null;
  }

  private indexFts(
    id: string,
    merchantKey: string,
    accountId: string,
    memo: string,
    band: string,
    categoryId: string
  ): void {
    if (!this.hasFts()) return;
    this.db.prepare(`
      INSERT INTO category_exemplars_fts (merchant_key, account_id, memo, amount_band, category_id, exemplar_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(merchantKey, accountId, memo, band, categoryId, id);
  }

  private hasFts(): boolean {
    const row = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'category_exemplars_fts'"
    ).get() as { name: string } | undefined;
    return Boolean(row);
  }

  private trigramFallback(merchantKey: string, accountId: string, band: string, limit: number): RetrievedExemplar[] {
    const rows = this.db.prepare(`
      SELECT merchant_key as merchantKey, account_id as accountId, amount_cents as amountCents,
             memo, category_id as categoryId
      FROM category_exemplars
    `).all() as Array<Omit<RetrievedExemplar, 'score'>>;
    return rows
      .map((row) => ({
        ...row,
        score: -overlap(merchantKey, row.merchantKey) - (row.accountId === accountId ? 2 : 0) - (amountBand(row.amountCents) === band ? 1 : 0),
      }))
      .sort((a, b) => a.score - b.score)
      .slice(0, limit);
  }
}

function overlap(a: string, b: string): number {
  const grams = (value: string) => {
    const padded = `  ${value} `;
    const set = new Set<string>();
    for (let i = 0; i < padded.length - 2; i++) set.add(padded.slice(i, i + 3));
    return set;
  };
  const left = grams(a);
  const right = grams(b);
  let shared = 0;
  for (const gram of left) {
    if (right.has(gram)) shared += 1;
  }
  return shared;
}
