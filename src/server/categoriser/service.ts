import { existsSync } from 'fs';
import type Database from 'better-sqlite3';
import { assertNotLLMSourced } from '../lib/llm-guards.js';
import { DEFAULT_CATEGORISER_AUTO_THRESHOLD } from '../lib/codex-defaults.js';
import { CODEX_EXEC_FAILED, CODEX_PARSE_FAILED } from '../lib/llm-provider-codex.js';
import { logger } from '../lib/logger.js';
import { matchesAlwaysReview, parseAlwaysReviewPatterns } from './always-review.js';
import { readCsv } from './csv.js';
import { redactErrorCode } from './errors.js';
import { ExemplarStore } from './exemplars.js';
import { deriveTransactionKind } from './kind.js';
import { MerchantMemory } from './memory.js';
import { assemblePrompt, buildPromptParts, DEFAULT_TOKEN_BUDGET, type PromptOption, type TransactionFacts } from './prompt.js';
import { formatEnrichmentLine, readCachedEnrichment } from '../services/merchant-enrichment-service.js';
import { TriangulateService } from '../services/context/triangulate.js';
import { OrderMatchService } from '../services/context/order-match.js';
import { createCategoriserProvider, type CategoriserProvider, type ProviderDecision } from './providers.js';
import { loadCondensedRules } from './rules.js';
import { findCategory, leavesUnderL1, loadCategorySchema, uniqueL1, type CategoryKind, type CategorySchema } from './schema.js';
import { parsePayeeAndUen } from '../services/payee-parse.js';
import { citeResearchReason, guardCategoryDirection, guessFromSsic, NO_RESEARCH_MATCH } from '../services/ssic-guess.js';

export interface CategoriserOutcome {
  categoryId: string | null;
  confidence: number;
  probabilities: Record<string, number>;
  rationale: string;
  applied: boolean;
  review: boolean;
  source: 'memory' | 'provider' | 'none';
  kind: CategoryKind;
  step1?: ProviderDecision | null;
  step2?: ProviderDecision | null;
  inputTokens: number;
  outputTokens: number;
  callsMade: number;
  errorCode?: string;
}

export interface CategoriserOptions {
  schema?: CategorySchema;
  provider?: CategoriserProvider;
  autoThreshold?: number;
  tokenBudget?: number;
  seedMemoryCsv?: string | null;
  alwaysReview?: RegExp[];
}

export class CategoriserService {
  readonly schema: CategorySchema;
  readonly memory: MerchantMemory;
  readonly exemplars: ExemplarStore;
  readonly provider: CategoriserProvider;
  readonly autoThreshold: number;
  readonly tokenBudget: number;
  readonly alwaysReview: RegExp[];

  constructor(private db: Database.Database, options: CategoriserOptions = {}) {
    this.schema = options.schema ?? loadCategorySchema();
    this.memory = new MerchantMemory(db);
    this.exemplars = new ExemplarStore(db);
    this.provider = options.provider ?? createCategoriserProvider('none');
    this.autoThreshold = options.autoThreshold ?? Number(process.env.CATEGORISER_AUTO_THRESHOLD || DEFAULT_CATEGORISER_AUTO_THRESHOLD);
    this.tokenBudget = options.tokenBudget ?? Number(process.env.CATEGORISER_TOKEN_BUDGET || DEFAULT_TOKEN_BUDGET);
    this.alwaysReview = options.alwaysReview ?? parseAlwaysReviewPatterns();
    this.seedMemory(options.seedMemoryCsv !== undefined ? options.seedMemoryCsv : process.env.MERCHANT_MEMORY_CSV);
  }

  async categorizeFacts(txn: TransactionFacts): Promise<CategoriserOutcome> {
    const cached = (!txn.enrichment || !txn.ssicCode) ? readCachedEnrichment(this.db, txn.merchant) : null;
    const enrichment = txn.enrichment ?? (cached ? formatEnrichmentLine(cached) : null);
    txn = {
      ...txn,
      enrichment: txn.enrichment ?? enrichment,
      ssicCode: txn.ssicCode ?? cached?.ssicCode ?? null,
      ssicDescription: txn.ssicDescription ?? cached?.ssicDescription ?? null,
    };
    const kind = deriveTransactionKind(txn);
    const memoryHit = this.memory.lookup(txn.merchant);
    if (memoryHit?.flagAsk) {
      return this.finalize({
        categoryId: memoryHit.categoryId === 'flag' ? null : memoryHit.categoryId,
        confidence: 0,
        probabilities: {},
        rationale: 'flag/ask merchant memory',
        applied: false,
        review: true,
        source: 'memory',
        kind,
        inputTokens: 0,
        outputTokens: 0,
        callsMade: 0,
      }, txn);
    }
    if (memoryHit && this.memory.canAutoApply(memoryHit) && this.knownCategory(memoryHit.categoryId)) {
      const confidence = this.memory.confidence(memoryHit);
      return this.finalize({
        categoryId: memoryHit.categoryId,
        confidence,
        probabilities: { [memoryHit.categoryId]: confidence },
        rationale: `merchant memory ${memoryHit.match}`,
        applied: true,
        review: false,
        source: 'memory',
        kind,
        inputTokens: 0,
        outputTokens: 0,
        callsMade: 0,
      }, txn);
    }

    const rules = loadCondensedRules(this.db, this.schema);
    const digests = this.memory.relatedDigests(txn.merchant);
    const similar = this.exemplars.retrieveSimilar({
      merchant: txn.merchant,
      accountId: txn.accountId,
      amountCents: txn.amountCents,
      memo: txn.memo,
      categoryId: '',
    }, 8);

    const l1Options = uniqueL1(this.schema).map((node) => ({
      id: node.id,
      label: `${node.id} / ${node.kind}`,
      description: node.description,
    }));
    let step1: { decision: ProviderDecision; tokens: number } | null;
    try {
      step1 = await this.ask('Choose L1/kind', txn, l1Options, rules, digests, similar, []);
    } catch (error) {
      return this.providerFailure(txn, kind, error);
    }
    if (!step1) {
      const ssic = guessFromSsic({
        ssicCode: txn.ssicCode,
        ssicDescription: txn.ssicDescription,
        amountCents: txn.amountCents,
        merchantText: txn.merchant,
      });
      if (ssic && this.knownCategory(ssic.categoryId)) {
        return this.finalize({
          categoryId: ssic.categoryId,
          confidence: ssic.confidence,
          probabilities: { [ssic.categoryId]: ssic.confidence },
          rationale: citeResearchReason({
            ssicCode: txn.ssicCode,
            ssicDescription: txn.ssicDescription,
            amountCents: txn.amountCents,
            merchantText: txn.merchant,
            categoryId: ssic.categoryId,
          }),
          applied: false,
          review: true,
          source: 'none',
          kind,
          inputTokens: 0,
          outputTokens: 0,
          callsMade: 0,
        }, txn);
      }
      const opaque = parsePayeeAndUen(txn.merchant).opaque;
      const confidence = memoryHit ? this.memory.confidence(memoryHit) : 0;
      return this.finalize({
        categoryId: memoryHit && this.knownCategory(memoryHit.categoryId) ? memoryHit.categoryId : null,
        confidence,
        probabilities: memoryHit ? { [memoryHit.categoryId]: confidence } : {},
        rationale: opaque
          ? NO_RESEARCH_MATCH
          : memoryHit ? 'weak merchant memory; no provider' : 'no memory hit and no provider',
        applied: false,
        review: opaque || Boolean(memoryHit),
        source: memoryHit ? 'memory' : 'none',
        kind,
        inputTokens: 0,
        outputTokens: 0,
        callsMade: 0,
      }, txn);
    }

    const leaves = leavesUnderL1(this.schema, step1.decision.optionId);
    const leafOptions = (leaves.length ? leaves : this.schema.categories).map((node) => ({
      id: node.id,
      label: node.path.join(' / '),
      description: node.description,
    }));
    const canonical = leafOptions
      .map((option) => this.exemplars.canonicalFor(option.id))
      .filter((row): row is NonNullable<typeof row> => Boolean(row));
    let step2: { decision: ProviderDecision; tokens: number } | null;
    try {
      step2 = await this.ask('Choose leaf category', txn, leafOptions, rules, digests, similar, canonical);
    } catch (error) {
      return this.providerFailure(txn, kind, error);
    }
    const decision = step2?.decision ?? step1.decision;
    const categoryId = findCategory(this.schema, decision.optionId)?.id
      ?? leaves.find((leaf) => leaf.id === decision.optionId)?.id
      ?? null;
    const confidence = decision.confidence;
    const applied = Boolean(categoryId) && confidence >= this.autoThreshold;
    return this.finalize({
      categoryId,
      confidence,
      probabilities: decision.probabilities,
      rationale: decision.rationale,
      applied,
      review: !applied,
      source: 'provider',
      kind,
      step1: step1.decision,
      step2: step2?.decision ?? null,
      inputTokens: (step1.tokens) + (step2?.tokens ?? 0),
      outputTokens: step1.decision.outputTokens + (step2?.decision.outputTokens ?? 0),
      callsMade: 1 + (step2 ? 1 : 0),
    }, txn);
  }

  async categorizeTransaction(transactionId: string, documentHash?: string): Promise<CategoriserOutcome> {
    const tx = this.db.prepare(
      'SELECT merchant_text, normalized_merchant, amount_cents, account_id, notes, category FROM transactions WHERE id = ?'
    ).get(transactionId) as {
      merchant_text: string;
      normalized_merchant: string | null;
      amount_cents: number;
      account_id: string;
      notes: string | null;
      category: string | null;
    } | undefined;
    if (!tx) {
      return emptyOutcome('missing transaction');
    }
    if (tx.category) {
      const facts = {
        merchant: tx.normalized_merchant || tx.merchant_text,
        accountId: tx.account_id,
        amountCents: tx.amount_cents,
        memo: tx.notes,
      };
      return {
        categoryId: tx.category,
        confidence: 1,
        probabilities: { [tx.category]: 1 },
        rationale: 'already labelled',
        applied: false,
        review: false,
        source: 'none',
        kind: deriveTransactionKind(facts),
        inputTokens: 0,
        outputTokens: 0,
        callsMade: 0,
      };
    }

    const outcome = await this.categorizeFacts({
      merchant: tx.normalized_merchant || tx.merchant_text,
      accountId: tx.account_id,
      amountCents: tx.amount_cents,
      memo: tx.notes,
      contextEvidence: this.contextEvidence(transactionId),
    });

    if (outcome.applied && outcome.categoryId) {
      this.db.prepare('UPDATE transactions SET category = ?, updated_at = ? WHERE id = ?')
        .run(outcome.categoryId, Date.now(), transactionId);
    } else if (outcome.review) {
      this.db.prepare(`
        INSERT OR IGNORE INTO review_queue (id, observation_id, document_hash, reason, detail, created_at)
        VALUES (?, NULL, ?, 'low_confidence_category', ?, ?)
      `).run(
        `cat-${transactionId}`,
        documentHash ?? null,
        JSON.stringify({
          transactionId,
          categoryId: outcome.categoryId,
          confidence: outcome.confidence,
          rationale: outcome.rationale,
          // Pipeline order is enrich-merchant → triangulate → categorize, so
          // research has already run (hit or miss) by the time we queue review.
          researchComplete: true,
        }),
        Date.now()
      );
    }
    return outcome;
  }

  /**
   * Extra facts for the prompt: triangulated context plus the items of any matched
   * marketplace order. Advisory only: this path runs for uncategorised transactions
   * and a user's category is never overridden.
   */
  contextEvidence(transactionId: string): string | null {
    const parts = [
      new TriangulateService(this.db).evidenceLine(transactionId),
      new OrderMatchService(this.db).evidenceLine(transactionId),
    ].filter((part): part is string => Boolean(part));
    return parts.length ? parts.join('; ') : null;
  }

  recordCorrection(transactionId: string, categoryId: string): void {
    assertNotLLMSourced({ source: 'user' }, 'category correction');
    if (!findCategory(this.schema, categoryId)) {
      throw new Error(`Unknown category ${categoryId}`);
    }
    const tx = this.db.prepare(
      'SELECT merchant_text, normalized_merchant, amount_cents, account_id, notes FROM transactions WHERE id = ?'
    ).get(transactionId) as {
      merchant_text: string;
      normalized_merchant: string | null;
      amount_cents: number;
      account_id: string;
      notes: string | null;
    } | undefined;
    if (!tx) throw new Error(`Unknown transaction ${transactionId}`);
    this.db.prepare('UPDATE transactions SET category = ?, updated_at = ? WHERE id = ?')
      .run(categoryId, Date.now(), transactionId);
    this.rememberLabel(transactionId, categoryId);
  }

  rememberLabel(transactionId: string, categoryId: string): void {
    if (!findCategory(this.schema, categoryId)) return;
    const tx = this.db.prepare(
      'SELECT merchant_text, normalized_merchant, amount_cents, account_id, notes FROM transactions WHERE id = ?'
    ).get(transactionId) as {
      merchant_text: string;
      normalized_merchant: string | null;
      amount_cents: number;
      account_id: string;
      notes: string | null;
    } | undefined;
    if (!tx) return;
    this.memory.add(tx.normalized_merchant || tx.merchant_text, categoryId, 1, false);
    this.exemplars.add({
      merchant: tx.normalized_merchant || tx.merchant_text,
      accountId: tx.account_id,
      amountCents: tx.amount_cents,
      memo: tx.notes,
      categoryId,
      source: 'user',
    });
  }

  private finalize(outcome: CategoriserOutcome, txn: TransactionFacts): CategoriserOutcome {
    const guarded = guardCategoryDirection(this.schema, outcome.categoryId, txn.amountCents);
    let next = outcome;
    if (guarded.blocked) {
      const ssic = guessFromSsic({
        ssicCode: txn.ssicCode,
        ssicDescription: txn.ssicDescription,
        amountCents: txn.amountCents,
        merchantText: txn.merchant,
      });
      const fallback = ssic && this.knownCategory(ssic.categoryId) ? ssic : null;
      next = {
        ...outcome,
        categoryId: fallback?.categoryId ?? null,
        confidence: fallback?.confidence ?? 0,
        probabilities: fallback ? { [fallback.categoryId]: fallback.confidence } : {},
        rationale: fallback
          ? `${guarded.reason}; ${fallback.rationale}`
          : `${outcome.rationale}; ${guarded.reason}`,
        applied: false,
        review: true,
      };
    }
    if (!matchesAlwaysReview(txn, this.alwaysReview)) return next;
    return {
      ...next,
      applied: false,
      review: true,
      rationale: `${next.rationale}; always-review rule`,
    };
  }

  private providerFailure(txn: TransactionFacts, kind: CategoryKind, error: unknown): CategoriserOutcome {
    const code = redactErrorCode(error);
    const known = code === CODEX_EXEC_FAILED || code === CODEX_PARSE_FAILED || code === 'CATEGORISE_FAILED';
    const errorCode = known ? code : 'CATEGORISE_FAILED';
    return this.finalize({
      categoryId: null,
      confidence: 0,
      probabilities: {},
      rationale: errorCode,
      applied: false,
      review: true,
      source: 'provider',
      kind,
      errorCode,
      inputTokens: 0,
      outputTokens: 0,
      callsMade: 1,
    }, txn);
  }

  private knownCategory(id: string): boolean {
    if (!id || id === 'flag') return false;
    if (this.schema.categories.length === 0) return true;
    return Boolean(findCategory(this.schema, id));
  }

  private seedMemory(seedPath: string | null | undefined): void {
    if (!seedPath) return;
    if (!existsSync(seedPath)) {
      logger.warn('MERCHANT_MEMORY_CSV missing');
      return;
    }
    this.memory.seedCsv(readCsv(seedPath));
  }

  private async ask(
    question: string,
    txn: TransactionFacts,
    options: PromptOption[],
    rules: string,
    digests: string[],
    similar: ReturnType<ExemplarStore['retrieveSimilar']>,
    canonical: NonNullable<ReturnType<ExemplarStore['canonicalFor']>>[]
  ): Promise<{ decision: ProviderDecision; tokens: number } | null> {
    const parts = buildPromptParts(txn, question, options, rules, digests, similar, canonical);
    const assembled = assemblePrompt(parts, this.tokenBudget);
    const decision = await this.provider.choose(question, assembled.prompt, options);
    if (!decision) return null;
    return { decision, tokens: decision.inputTokens };
  }
}

function emptyOutcome(rationale: string): CategoriserOutcome {
  return {
    categoryId: null,
    confidence: 0,
    probabilities: {},
    rationale,
    applied: false,
    review: false,
    source: 'none',
    kind: 'expense',
    inputTokens: 0,
    outputTokens: 0,
    callsMade: 0,
  };
}
