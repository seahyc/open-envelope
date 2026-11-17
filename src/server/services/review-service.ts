import type Database from 'better-sqlite3';
import crypto from 'crypto';
import { assertNotLLMSourced } from '../lib/llm-guards.js';
import { findCategory, type CategorySchema } from '../categoriser/schema.js';
import { normalizeMerchantKey } from '../categoriser/normalize.js';
import {
  enrichmentServiceFromEnv,
  formatEnrichmentLine,
  readCachedEnrichment,
  type MerchantEnrichmentService,
} from './merchant-enrichment-service.js';
import { TriangulateService, type ContextSnippet } from './context/triangulate.js';
import { parsePayeeAndUen } from './payee-parse.js';
import { hh } from '../lib/tenancy.js';
import { buildResearchSummary, type ResearchSummary, type ReviewEntity } from './research-summary.js';
import {
  NO_RESEARCH_MATCH,
  citeResearchReason,
  guessFromSsic,
} from './ssic-guess.js';

export const CAPITAL_TRANSFER_CATEGORY = 'xfer.capital';
export const CAPITAL_TRANSFER_MIN_CENTS = 100_000;

export interface PayeeNoteRecord {
  payeeLabel: string;
  project: string | null;
  categoryId: string | null;
}

export interface ReviewItem {
  id: string;
  reason: string;
  detail: Record<string, unknown> | null;
  createdAt: number;
  transactionId: string | null;
  merchantText: string;
  merchantKey: string;
  amountCents: number | null;
  currency: string;
  timestamp: number | null;
  accountId: string | null;
  accountName: string | null;
  currentCategory: string | null;
  suggestedCategoryId: string | null;
  suggestedCategoryLabel: string | null;
  confidence: number | null;
  rationale: string | null;
  enrichmentLine: string | null;
  enrichmentSource: 'acra' | 'web' | null;
  enrichmentUrls: string[];
  probablyWas: string;
  entity: ReviewEntity | null;
  thatDay: string;
  suggestedPayee: string;
  suggestedReason: string;
  researchPending: boolean;
  contextSnippets: ContextSnippet[];
  spentBy: string | null;
  opaque: boolean;
  payeeName: string;
  uen: string | null;
  payeeNote: PayeeNoteRecord | null;
  showPayeeNotes: boolean;
  showCapitalTransfer: boolean;
}

export interface ReviewGroup {
  merchantKey: string;
  merchantText: string;
  count: number;
  suggestedCategoryId: string | null;
  suggestedCategoryLabel: string | null;
  confidence: number | null;
  items: ReviewItem[];
}

export interface ReviewList {
  count: number;
  items: ReviewItem[];
  groups: ReviewGroup[];
}

export interface ReviewUndoPayload {
  rows: Array<{
    reviewId: string;
    transactionId: string | null;
    previousCategory: string | null;
    previousResolved: number;
  }>;
  ruleId: string | null;
  payeeNote?: {
    merchantKey: string;
    previous: PayeeNoteRecord | null;
  } | null;
}

interface CategoriserLike {
  schema: CategorySchema;
  rememberLabel(transactionId: string, categoryId: string): void;
}

function parseDetail(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function categoryLabel(schema: CategorySchema, categoryId: string | null): string | null {
  if (!categoryId) return null;
  const found = findCategory(schema, categoryId);
  return found ? found.path.join(' ▸ ') : categoryId;
}

function reasonRank(reason: string): number {
  if (reason === 'unbalanced_period' || reason.includes('unbalanced')) return 0;
  if (reason === 'possible_transfer') return 1;
  return 2;
}

function enrichmentFields(db: Database.Database, merchantText: string): {
  enrichmentLine: string | null;
  enrichmentSource: 'acra' | 'web' | null;
  enrichmentUrls: string[];
} {
  const cached = readCachedEnrichment(db, merchantText);
  if (!cached) {
    return { enrichmentLine: null, enrichmentSource: null, enrichmentUrls: [] };
  }
  return {
    enrichmentLine: formatEnrichmentLine(cached),
    enrichmentSource: cached.source,
    enrichmentUrls: cached.sourceUrls,
  };
}

export class ReviewService {
  constructor(
    private db: Database.Database,
    private categoriser: CategoriserLike,
    private enrichment: MerchantEnrichmentService = enrichmentServiceFromEnv(db)
  ) {}

  list(): ReviewList {
    const rows = this.db.prepare(`
      SELECT
        rq.id,
        rq.reason,
        rq.detail,
        rq.created_at,
        COALESCE(
          CASE WHEN json_valid(rq.detail) THEN json_extract(rq.detail, '$.transactionId') END,
          CASE WHEN rq.id LIKE 'cat-%' THEN substr(rq.id, 5) END,
          t.id
        ) as transaction_id,
        COALESCE(t.merchant_text, o.merchant_text, '') as merchant_text,
        COALESCE(t.amount_cents, o.amount_cents) as amount_cents,
        COALESCE(t.currency, o.currency, 'SGD') as currency,
        COALESCE(t.timestamp, o.timestamp) as timestamp,
        t.category as current_category,
        t.account_id as account_id,
        a.name as account_name
      FROM review_queue rq
      LEFT JOIN observations o ON o.id = rq.observation_id
      LEFT JOIN transactions t ON t.id = COALESCE(
        CASE WHEN json_valid(rq.detail) THEN json_extract(rq.detail, '$.transactionId') END,
        CASE WHEN rq.id LIKE 'cat-%' THEN substr(rq.id, 5) END
      )
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE rq.household_id = ? AND rq.resolved = 0
      ORDER BY rq.created_at DESC
    `).all(hh()) as Array<{
      id: string;
      reason: string;
      detail: string | null;
      created_at: number;
      transaction_id: string | null;
      merchant_text: string;
      amount_cents: number | null;
      currency: string;
      timestamp: number | null;
      current_category: string | null;
      account_id: string | null;
      account_name: string | null;
    }>;

    const triangulate = new TriangulateService(this.db);
    const items = rows.map((row) => {
      const detail = parseDetail(row.detail);
      const suggestedCategoryId = typeof detail?.categoryId === 'string' ? detail.categoryId : null;
      const merchantText = row.merchant_text;
      const contextSnippets = row.transaction_id ? triangulate.snippetsFor(row.transaction_id) : [];
      const parsed = parsePayeeAndUen(merchantText);
      const merchantKey = normalizeMerchantKey(merchantText) || merchantText.trim().toLowerCase();
      const payeeNote = this.readPayeeNote(merchantKey);
      const largeItem = Math.abs(row.amount_cents ?? 0) >= CAPITAL_TRANSFER_MIN_CENTS;
      const cached = readCachedEnrichment(this.db, merchantText);
      const researchComplete = Boolean(cached) || detail?.researchComplete === true;
      const researchPending = parsed.opaque && !researchComplete;
      const research: ResearchSummary = buildResearchSummary({
        merchantText,
        amountCents: row.amount_cents,
        categoryId: suggestedCategoryId,
        rationale: typeof detail?.rationale === 'string' ? detail.rationale : null,
        savedPayee: payeeNote?.payeeLabel ?? null,
        snippets: contextSnippets,
        enrichment: cached,
        researchComplete,
      });
      const guess = researchPending
        ? { categoryId: null as string | null, label: null as string | null, confidence: null as number | null, reason: '' }
        : {
            categoryId: suggestedCategoryId,
            label: categoryLabel(this.categoriser.schema, suggestedCategoryId),
            confidence: typeof detail?.confidence === 'number' ? detail.confidence : null,
            reason: research.suggestedReason,
          };
      if (!researchPending && cached) {
        const ssic = guessFromSsic({
          ssicCode: cached.ssicCode,
          ssicDescription: cached.ssicDescription,
          amountCents: row.amount_cents ?? 0,
          merchantText,
        });
        if (ssic) {
          guess.categoryId = ssic.categoryId;
          guess.label = categoryLabel(this.categoriser.schema, ssic.categoryId);
          guess.confidence = ssic.confidence;
          guess.reason = citeResearchReason({
            ssicCode: cached.ssicCode,
            ssicDescription: cached.ssicDescription,
            amountCents: row.amount_cents ?? 0,
            merchantText,
            categoryId: ssic.categoryId,
          });
        } else if (researchComplete) {
          guess.reason = NO_RESEARCH_MATCH;
        }
      } else if (!researchPending && researchComplete && parsed.opaque) {
        guess.reason = NO_RESEARCH_MATCH;
      }
      return {
        id: row.id,
        reason: row.reason,
        detail,
        createdAt: row.created_at,
        transactionId: row.transaction_id,
        merchantText,
        merchantKey,
        amountCents: row.amount_cents,
        currency: row.currency,
        timestamp: row.timestamp,
        accountId: row.account_id,
        accountName: row.account_name,
        currentCategory: row.current_category,
        suggestedCategoryId: guess.categoryId,
        suggestedCategoryLabel: guess.label,
        confidence: guess.confidence,
        rationale: typeof detail?.rationale === 'string' ? detail.rationale : null,
        ...enrichmentFields(this.db, merchantText),
        probablyWas: researchPending ? '' : research.probablyWas,
        entity: research.entity,
        thatDay: research.thatDay,
        suggestedPayee: research.suggestedPayee,
        suggestedReason: guess.reason,
        researchPending,
        contextSnippets,
        spentBy: contextSnippets.find((snippet) => snippet.memberName)?.memberName ?? null,
        opaque: parsed.opaque,
        payeeName: parsed.payeeName,
        uen: parsed.uen,
        payeeNote,
        showPayeeNotes: parsed.opaque || Boolean(payeeNote),
        showCapitalTransfer: largeItem,
      };
    });

    items.sort((a, b) => {
      const rank = reasonRank(a.reason) - reasonRank(b.reason);
      if (rank !== 0) return rank;
      const merchant = a.merchantKey.localeCompare(b.merchantKey);
      if (merchant !== 0) return merchant;
      return (b.timestamp ?? 0) - (a.timestamp ?? 0);
    });

    const groupMap = new Map<string, ReviewGroup>();
    for (const item of items) {
      const key = item.merchantKey || item.id;
      const existing = groupMap.get(key);
      if (existing) {
        existing.items.push(item);
        existing.count += 1;
        if ((item.confidence ?? 0) > (existing.confidence ?? 0)) {
          existing.confidence = item.confidence;
          existing.suggestedCategoryId = item.suggestedCategoryId;
          existing.suggestedCategoryLabel = item.suggestedCategoryLabel;
          existing.merchantText = item.merchantText;
        }
      } else {
        groupMap.set(key, {
          merchantKey: key,
          merchantText: item.merchantText,
          count: 1,
          suggestedCategoryId: item.suggestedCategoryId,
          suggestedCategoryLabel: item.suggestedCategoryLabel,
          confidence: item.confidence,
          items: [item],
        });
      }
    }

    return { count: items.length, items, groups: [...groupMap.values()] };
  }

  async enrich(reviewId: string, options: { refresh?: boolean } = {}): Promise<ReviewItem> {
    const item = this.requireOpenItem(reviewId);
    if (!item.opaque && !item.uen) {
      this.markResearchComplete(item);
      return this.requireOpenItem(reviewId);
    }
    if (!options.refresh && item.enrichmentLine) {
      this.markResearchComplete(item);
      return this.requireOpenItem(reviewId);
    }
    await this.enrichment.enrichMerchantText(item.merchantText, options);
    this.markResearchComplete(item);
    return this.requireOpenItem(reviewId);
  }

  private markResearchComplete(item: ReviewItem): void {
    const cached = readCachedEnrichment(this.db, item.merchantText);
    const ssic = cached
      ? guessFromSsic({
          ssicCode: cached.ssicCode,
          ssicDescription: cached.ssicDescription,
          amountCents: item.amountCents ?? 0,
          merchantText: item.merchantText,
        })
      : null;
    const detail = { ...(item.detail ?? {}) };
    detail.researchComplete = true;
    if (ssic) {
      detail.categoryId = ssic.categoryId;
      detail.confidence = ssic.confidence;
      detail.rationale = citeResearchReason({
        ssicCode: cached?.ssicCode,
        ssicDescription: cached?.ssicDescription,
        amountCents: item.amountCents ?? 0,
        merchantText: item.merchantText,
        categoryId: ssic.categoryId,
      });
    } else {
      detail.rationale = NO_RESEARCH_MATCH;
    }
    this.db.prepare('UPDATE review_queue SET detail = ? WHERE id = ? AND household_id = ?')
      .run(JSON.stringify(detail), item.id, hh());
  }

  resolve(
    reviewId: string,
    options: { categoryId?: string; skip?: boolean; rememberRule?: boolean } = {}
  ): { undoId: string } {
    assertNotLLMSourced({ source: 'user' }, 'review resolve');
    const item = this.requireOpenItem(reviewId);
    return this.applyItems([item], options);
  }

  savePayeeNote(
    reviewId: string,
    options: { payeeLabel?: string; project?: string; capitalTransfer?: boolean; categoryId?: string } = {}
  ): { undoId: string } {
    assertNotLLMSourced({ source: 'user' }, 'review payee note');
    const item = this.requireOpenItem(reviewId);
    if (options.capitalTransfer) {
      return this.applyItems([item], {
        categoryId: CAPITAL_TRANSFER_CATEGORY,
        rememberRule: false,
        rememberLabel: false,
      });
    }
    const payeeLabel = (options.payeeLabel ?? '').trim();
    if (!payeeLabel) {
      throw new Error('payeeLabel is required');
    }
    const categoryId = options.categoryId
      || item.suggestedCategoryId
      || (typeof item.detail?.categoryId === 'string' ? item.detail.categoryId : undefined)
      || undefined;
    const project = (options.project ?? '').trim() || null;
    const previous = this.readPayeeNote(item.merchantKey);
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO payee_notes (
        household_id, merchant_key, payee_label, project, category_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(household_id, merchant_key) DO UPDATE SET
        payee_label = excluded.payee_label,
        project = excluded.project,
        category_id = COALESCE(excluded.category_id, payee_notes.category_id),
        updated_at = excluded.updated_at
    `).run(hh(), item.merchantKey, payeeLabel, project, categoryId ?? null, now, now);

    if (!categoryId) {
      const undoId = crypto.randomBytes(12).toString('hex');
      this.db.prepare('INSERT INTO review_undos (id, payload, created_at) VALUES (?, ?, ?)').run(
        undoId,
        JSON.stringify({
          rows: [],
          ruleId: null,
          payeeNote: { merchantKey: item.merchantKey, previous },
        } satisfies ReviewUndoPayload),
        now
      );
      return { undoId };
    }

    const result = this.applyItems([item], {
      categoryId,
      rememberRule: true,
    });
    this.attachPayeeNoteUndo(result.undoId, item.merchantKey, previous);
    return result;
  }

  bulk(
    ids: string[],
    options: { categoryId: string; rememberRule?: boolean }
  ): { undoId: string; accepted: number } {
    assertNotLLMSourced({ source: 'user' }, 'review bulk');
    if (!options.categoryId) throw new Error('categoryId is required');
    const wanted = new Set(ids);
    const items = this.list().items.filter((item) => wanted.has(item.id));
    if (items.length === 0) throw new Error('No open review items matched');
    const result = this.applyItems(items, options);
    return { undoId: result.undoId, accepted: items.length };
  }

  undo(undoId: string): { restored: number } {
    assertNotLLMSourced({ source: 'user' }, 'review undo');
    const row = this.db.prepare('SELECT payload FROM review_undos WHERE id = ?').get(undoId) as
      | { payload: string }
      | undefined;
    if (!row) throw new Error('Nothing to undo');
    const payload = JSON.parse(row.payload) as ReviewUndoPayload;
    const now = Date.now();
    for (const entry of payload.rows) {
      this.db.prepare(
        'UPDATE review_queue SET resolved = ?, resolved_at = ? WHERE id = ?'
      ).run(entry.previousResolved, entry.previousResolved ? now : null, entry.reviewId);
      if (entry.transactionId) {
        this.db.prepare('UPDATE transactions SET category = ?, updated_at = ? WHERE id = ?')
          .run(entry.previousCategory, now, entry.transactionId);
      }
    }
    if (payload.ruleId) {
      this.db.prepare('DELETE FROM merchant_rules WHERE id = ?').run(payload.ruleId);
    }
    if (payload.payeeNote) {
      if (payload.payeeNote.previous) {
        const prev = payload.payeeNote.previous;
        this.db.prepare(`
          INSERT INTO payee_notes (
            household_id, merchant_key, payee_label, project, category_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(household_id, merchant_key) DO UPDATE SET
            payee_label = excluded.payee_label,
            project = excluded.project,
            category_id = excluded.category_id,
            updated_at = excluded.updated_at
        `).run(
          hh(),
          payload.payeeNote.merchantKey,
          prev.payeeLabel,
          prev.project,
          prev.categoryId,
          now,
          now
        );
      } else {
        this.db.prepare('DELETE FROM payee_notes WHERE household_id = ? AND merchant_key = ?')
          .run(hh(), payload.payeeNote.merchantKey);
      }
    }
    this.db.prepare('DELETE FROM review_undos WHERE id = ?').run(undoId);
    return { restored: payload.rows.length };
  }

  private requireOpenItem(reviewId: string): ReviewItem {
    const item = this.list().items.find((entry) => entry.id === reviewId);
    if (!item) {
      const existing = this.db.prepare('SELECT id, resolved FROM review_queue WHERE id = ? AND household_id = ?').get(reviewId, hh()) as
        | { id: string; resolved: number }
        | undefined;
      if (existing?.resolved) {
        const error = new Error('Review item already resolved');
        (error as Error & { status: number }).status = 409;
        throw error;
      }
      throw new Error('Review item not found');
    }
    return item;
  }

  private applyItems(
    items: ReviewItem[],
    options: { categoryId?: string; skip?: boolean; rememberRule?: boolean; rememberLabel?: boolean }
  ): { undoId: string } {
    const categoryId = options.categoryId;
    if (categoryId && !findCategory(this.categoriser.schema, categoryId)) {
      throw new Error(`Unknown category ${categoryId}`);
    }

    const undoRows: ReviewUndoPayload['rows'] = [];
    const now = Date.now();

    for (const item of items) {
      const previous = this.db.prepare(
        'SELECT resolved FROM review_queue WHERE id = ?'
      ).get(item.id) as { resolved: number } | undefined;
      undoRows.push({
        reviewId: item.id,
        transactionId: item.transactionId,
        previousCategory: item.currentCategory,
        previousResolved: previous?.resolved ?? 0,
      });

      if (categoryId && item.transactionId && !options.skip) {
        this.db.prepare('UPDATE transactions SET category = ?, updated_at = ? WHERE id = ?')
          .run(categoryId, now, item.transactionId);
        if (options.rememberLabel !== false) {
          this.categoriser.rememberLabel(item.transactionId, categoryId);
        }
      }

      this.db.prepare(
        'UPDATE review_queue SET resolved = 1, resolved_at = ? WHERE id = ? AND resolved = 0'
      ).run(now, item.id);
    }

    let ruleId: string | null = null;
    if (options.rememberRule && categoryId && items[0]) {
      ruleId = crypto.randomBytes(8).toString('hex');
      this.db.prepare(`
        INSERT INTO merchant_rules (id, household_id, pattern, category, envelope_id, created_at)
        VALUES (?, ?, ?, ?, NULL, ?)
      `).run(ruleId, hh(), items[0].merchantText, categoryId, now);
    }

    const undoId = crypto.randomBytes(12).toString('hex');
    this.db.prepare('INSERT INTO review_undos (id, payload, created_at) VALUES (?, ?, ?)').run(
      undoId,
      JSON.stringify({ rows: undoRows, ruleId } satisfies ReviewUndoPayload),
      now
    );
    return { undoId };
  }

  private readPayeeNote(merchantKey: string): PayeeNoteRecord | null {
    if (!merchantKey) return null;
    const row = this.db.prepare(`
      SELECT payee_label as payeeLabel, project, category_id as categoryId
      FROM payee_notes
      WHERE household_id = ? AND merchant_key = ?
    `).get(hh(), merchantKey) as
      | { payeeLabel: string; project: string | null; categoryId: string | null }
      | undefined;
    if (!row) return null;
    return {
      payeeLabel: row.payeeLabel,
      project: row.project,
      categoryId: row.categoryId,
    };
  }

  private attachPayeeNoteUndo(
    undoId: string,
    merchantKey: string,
    previous: PayeeNoteRecord | null
  ): void {
    const row = this.db.prepare('SELECT payload FROM review_undos WHERE id = ?').get(undoId) as
      | { payload: string }
      | undefined;
    if (!row) return;
    const payload = JSON.parse(row.payload) as ReviewUndoPayload;
    payload.payeeNote = { merchantKey, previous };
    this.db.prepare('UPDATE review_undos SET payload = ? WHERE id = ?')
      .run(JSON.stringify(payload), undoId);
  }
}
