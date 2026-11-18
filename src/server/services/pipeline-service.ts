import type Database from 'better-sqlite3';
import { logger } from '../lib/logger.js';
import type { LLMProvider } from '../lib/llm-provider.js';
import { assertNotLLMSourced } from '../lib/llm-guards.js';
import crypto from 'crypto';
import { MerchantNormalizationService } from './merchant-normalization-service.js';
import { LLMFallbackParser } from './llm-fallback-parser.js';
import { resolveAccountId } from '../lib/account-resolve.js';
import { PipelineRecorder, timedStage } from '../pipeline/recorder.js';
import { defineStage, runStages } from '../pipeline/runner.js';
import type { Stage } from '../pipeline/stage.js';
import { stageResult } from '../pipeline/stage.js';
import { LINEAR_STAGES } from '../pipeline/definition.js';
import { hh } from '../lib/tenancy.js';
import { CategoriserService } from '../categoriser/service.js';
import { createCategoriserProvider, providerConfigFromEnv } from '../categoriser/providers.js';
import { ReconciliationService } from './reconciliation-service.js';
import { TransferService } from './transfer-service.js';
import {
  enrichmentServiceFromEnv,
  hasMemoryOrRuleMatch,
  type MerchantEnrichmentService,
} from './merchant-enrichment-service.js';
import { parsePayeeAndUen } from './payee-parse.js';
import { contextFlag } from '../lib/context-flags.js';
import { TriangulateService } from './context/triangulate.js';
import { OrderMatchService } from './context/order-match.js';

type ObservationRow = {
  id: string;
  account_hint: string;
  adapter_name: string;
  timestamp: number;
  amount_cents: number;
  merchant_text: string;
  kind: string;
  currency: string;
  fx_currency: string | null;
  is_statement: number;
};

type DocumentState = {
  documentHash: string;
  observations: ObservationRow[];
  result: PipelineResult;
  matchedTxIds: string[];
};

function stageMeta(id: string): { name: string; version: string; description: string } {
  const node = LINEAR_STAGES.find((stage) => stage.id === id);
  return {
    name: node?.name ?? id,
    version: node?.version ?? '1.0.0',
    description: node?.description ?? id,
  };
}

export interface PipelineResult {
  documentHash: string;
  adapterName: string;
  observationsCreated: number;
  transactionsCreated: number;
  transactionsMerged: number;
  categorized: number;
  errors: string[];
  unparsed: boolean;
}

export interface AccountMapping {
  folderPattern?: string;
  accountHint?: string;
  accountAlias: string;
  accountId?: string;
}

export class PipelineService {
  private merchantNormalizationService: MerchantNormalizationService;
  private llmFallbackParser: LLMFallbackParser;
  private documentStore: { retrieve: (hash: string) => Promise<Buffer | null> };
  readonly recorder: PipelineRecorder;
  readonly categoriser: CategoriserService;
  private reconciliationService: ReconciliationService;
  private transferService: TransferService;
  private enrichment: MerchantEnrichmentService;
  readonly triangulate: TriangulateService;
  readonly orderMatch: OrderMatchService;

  constructor(
    private db: Database.Database,
    private llmProvider: LLMProvider | null,
    private accountMappings: AccountMapping[],
    documentStore?: { retrieve: (hash: string) => Promise<Buffer | null> }
  ) {
    this.merchantNormalizationService = new MerchantNormalizationService(db, llmProvider);
    this.llmFallbackParser = new LLMFallbackParser(db, llmProvider);
    this.documentStore = documentStore || { retrieve: async () => null };
    this.recorder = new PipelineRecorder(db);
    this.categoriser = new CategoriserService(db, {
      provider: createCategoriserProvider(process.env.CATEGORISER_PROVIDER || 'none', providerConfigFromEnv()),
    });
    this.reconciliationService = new ReconciliationService(db, accountMappings);
    this.transferService = new TransferService(db);
    this.enrichment = enrichmentServiceFromEnv(db);
    this.triangulate = new TriangulateService(db);
    this.orderMatch = new OrderMatchService(db);
  }

  async processDocument(
    documentHash: string,
    options: { skipLlmFallback?: boolean; runId?: string } = {}
  ): Promise<PipelineResult> {
    const result: PipelineResult = {
      documentHash,
      adapterName: '',
      observationsCreated: 0,
      transactionsCreated: 0,
      transactionsMerged: 0,
      categorized: 0,
      errors: [],
      unparsed: false,
    };

    const ownsRun = !options.runId;
    const runId = options.runId ?? this.recorder.beginRun(undefined, documentHash);

    try {
      const observations = this.db
        .prepare('SELECT * FROM observations WHERE document_hash = ? AND household_id = ?')
        .all(documentHash, hh()) as Array<{
          id: string;
          account_hint: string;
          adapter_name: string;
          timestamp: number;
          amount_cents: number;
          merchant_text: string;
          kind: string;
          currency: string;
          fx_currency: string | null;
          is_statement: number;
        }>;

      if (observations.length === 0) {
        const existingPeriods = this.db.prepare(
          'SELECT id FROM statement_periods WHERE document_hash = ?'
        ).all(documentHash) as Array<{ id: string }>;

        if (existingPeriods.length > 0) {
          await timedStage(this.recorder, runId, 'reconcile', '1.0.0', async () => {
            const flagged = await this.updateStatementPeriods(documentHash);
            return stageResult(null, { inputCount: existingPeriods.length, outputCount: existingPeriods.length, flaggedCount: flagged });
          });
          await this.recordReviewStage(runId, documentHash);
          if (ownsRun) this.recorder.finishRun(runId, 'success', { documentHash, flaggedCount: existingPeriods.length });
          return result;
        }

        result.unparsed = true;
        result.errors.push('No observations created');

        if (this.llmProvider && !options.skipLlmFallback) {
          await timedStage(this.recorder, runId, 'detect-format', '1.0.0', async () => {
            await this.tryLLMFallbackParser(documentHash);
            return stageResult(null, { inputCount: 1, outputCount: 0, adapterName: 'llm-fallback' });
          });
        }

        await this.recordReviewStage(runId, documentHash);
        if (ownsRun) {
          this.recorder.finishRun(runId, 'error', { documentHash, errorCount: 1, adapterName: 'llm-fallback' });
        }
        return result;
      }

      result.adapterName = observations[0]!.adapter_name;
      result.observationsCreated = observations.length;

      const finalState = await runStages(
        this.recorder,
        runId,
        this.documentStages(),
        {
          documentHash,
          observations,
          result,
          matchedTxIds: [],
        },
        { runId, documentHash, skipLlmFallback: options.skipLlmFallback }
      );

      if (ownsRun) {
        this.recorder.finishRun(runId, finalState.result.errors.length > 0 ? 'error' : 'success', {
          documentHash,
          adapterName: finalState.result.adapterName,
          observationsCreated: finalState.result.observationsCreated,
          transactionsCreated: finalState.result.transactionsCreated,
          transactionsMerged: finalState.result.transactionsMerged,
          errorCount: finalState.result.errors.length,
          flaggedCount: this.reviewCount(documentHash),
        });
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      result.errors.push(errorMsg);
      logger.error('Pipeline processing failed', { documentHash, error: errorMsg });
      if (ownsRun) {
        this.recorder.finishRun(runId, 'error', { documentHash, errorCount: 1, adapterName: result.adapterName });
      }
    }

    return result;
  }

  private reviewCount(documentHash: string): number {
    const flagged = this.db.prepare(
      `SELECT COUNT(*) as count FROM review_queue
       WHERE household_id = ?
         AND (document_hash = ? OR observation_id IN (SELECT id FROM observations WHERE document_hash = ? AND household_id = ?))`
    ).get(hh(), documentHash, documentHash, hh()) as { count: number };
    return flagged.count;
  }

  private reviewTransactionIds(documentHash: string): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT COALESCE(
        CASE WHEN json_valid(rq.detail) THEN json_extract(rq.detail, '$.transactionId') END,
        CASE WHEN rq.id LIKE 'cat-%' THEN substr(rq.id, 5) END
      ) as transaction_id
      FROM review_queue rq
      WHERE rq.household_id = ?
        AND rq.resolved = 0
        AND (rq.document_hash = ? OR rq.observation_id IN (
          SELECT id FROM observations WHERE document_hash = ? AND household_id = ?
        ))
    `).all(hh(), documentHash, documentHash, hh()) as Array<{ transaction_id: string | null }>;
    return rows.map((row) => row.transaction_id).filter((id): id is string => Boolean(id));
  }

  private documentStages(): Stage<DocumentState, DocumentState>[] {
    return [
      defineStage(stageMeta('resolve-account'), async (state) => {
        let resolved = 0;
        let flagged = 0;
        for (const obs of state.observations) {
          const accountId = await this.resolveAccount(obs.account_hint, state.documentHash);
          if (accountId) resolved += 1;
          else flagged += 1;
        }
        return stageResult(state, {
          inputCount: state.observations.length,
          outputCount: resolved,
          flaggedCount: flagged,
          errorCount: flagged,
          adapterName: state.result.adapterName,
        });
      }),
      defineStage(stageMeta('match'), async (state) => {
        let created = 0;
        let merged = 0;
        let unmatched = 0;
        for (const obs of state.observations) {
          const accountId = await this.resolveAccount(obs.account_hint, state.documentHash);

          if (!accountId) {
            state.result.errors.push(`Unmatched account hint: ${obs.account_hint}`);
            this.addToReviewQueue(obs.id, 'unmatched_account', obs.account_hint, state.documentHash);
            unmatched += 1;
            continue;
          }

          const txResult = await this.matchOrCreateTransaction(obs, accountId, obs.adapter_name);

          if (txResult.created) {
            state.result.transactionsCreated++;
            created += 1;
          }
          if (txResult.merged) {
            state.result.transactionsMerged++;
            merged += 1;
          }
          if (txResult.transactionId) {
            state.matchedTxIds.push(txResult.transactionId);
          }
        }
        // New card/bank lines may be the charge for a marketplace order that arrived earlier.
        // Deterministic and write-limited to orders.matched_transaction_id; runs before categorize
        // so the item titles are available as categoriser context.
        if (created + merged > 0) this.orderMatch.matchHousehold();
        return stageResult(state, {
          inputCount: state.observations.length,
          outputCount: created + merged,
          flaggedCount: unmatched,
          errorCount: unmatched,
          adapterName: state.result.adapterName,
        });
      }),
      defineStage(stageMeta('reconcile'), async (state) => {
        const flagged = await this.updateStatementPeriods(state.documentHash);
        const periods = this.db.prepare(
          'SELECT COUNT(*) as count FROM statement_periods WHERE document_hash = ?'
        ).get(state.documentHash) as { count: number };
        return stageResult(state, { inputCount: periods.count, outputCount: periods.count, flaggedCount: flagged });
      }),
      defineStage(stageMeta('detect-transfers'), async (state) => {
        const flagged = await this.detectTransfers(state.documentHash);
        return stageResult(state, { inputCount: state.observations.length, flaggedCount: flagged });
      }),
      defineStage(stageMeta('enrich-merchant'), async (state) => {
        const ids = [...new Set([...state.matchedTxIds, ...this.reviewTransactionIds(state.documentHash)])];
        let output = 0;
        for (const transactionId of ids) {
          const tx = this.db.prepare(
            'SELECT merchant_text, category FROM transactions WHERE id = ? AND household_id = ?'
          ).get(transactionId, hh()) as { merchant_text: string; category: string | null } | undefined;
          if (!tx || tx.category) continue;
          if (!parsePayeeAndUen(tx.merchant_text).opaque) continue;
          if (hasMemoryOrRuleMatch(this.db, tx.merchant_text)) continue;
          const row = await this.enrichment.enrichMerchantText(tx.merchant_text);
          if (row) output += 1;
        }
        return stageResult(state, {
          inputCount: ids.length,
          outputCount: output,
        });
      }),
      defineStage({ ...stageMeta('triangulate'), enabled: contextFlag('triangulate') }, async (state) => {
        const output = this.triangulate.forTransactions(state.matchedTxIds);
        return stageResult(state, {
          inputCount: state.matchedTxIds.length,
          outputCount: output,
        });
      }),
      defineStage(stageMeta('categorize'), async (state, ctx) => {
        let memoryOut = 0;
        let providerOut = 0;
        let thresholdOut = 0;
        let flagged = 0;
        for (const transactionId of state.matchedTxIds) {
          const outcome = await this.categoriser.categorizeTransaction(transactionId, state.documentHash);
          if (outcome.source === 'memory' && outcome.applied) memoryOut += 1;
          if (outcome.source === 'provider') providerOut += 1;
          if (outcome.applied) thresholdOut += 1;
          if (outcome.review) flagged += 1;
          await this.normalizeMerchant(transactionId);
          state.result.categorized++;
        }
        this.recorder.recordStage(ctx.runId, 'categorize:memory', '1.0.0', {
          inputCount: state.matchedTxIds.length, outputCount: memoryOut, errorCount: 0, flaggedCount: 0, errors: [],
        }, 0);
        this.recorder.recordStage(ctx.runId, 'categorize:rules', '1.0.0', {
          inputCount: state.matchedTxIds.length, outputCount: state.matchedTxIds.length, errorCount: 0, flaggedCount: 0, errors: [],
        }, 0);
        this.recorder.recordStage(ctx.runId, 'categorize:provider', '1.0.0', {
          inputCount: state.matchedTxIds.length, outputCount: providerOut, errorCount: 0, flaggedCount: 0, errors: [],
        }, 0);
        this.recorder.recordStage(ctx.runId, 'categorize:threshold', '1.0.0', {
          inputCount: state.matchedTxIds.length, outputCount: thresholdOut, errorCount: 0, flaggedCount: flagged, errors: [],
        }, 0);
        return stageResult(state, {
          inputCount: state.matchedTxIds.length,
          outputCount: state.matchedTxIds.length,
          flaggedCount: flagged,
        });
      }),
      defineStage(stageMeta('flag-rules'), async (state) => {
        const flagged = this.reviewCount(state.documentHash);
        return stageResult(state, { inputCount: state.observations.length, flaggedCount: flagged });
      }),
      defineStage(stageMeta('review-queue'), async (state) => {
        const flagged = this.reviewCount(state.documentHash);
        return stageResult(state, { outputCount: flagged, flaggedCount: flagged });
      }),
    ];
  }

  private async recordReviewStage(runId: string, documentHash: string) {
    return timedStage(this.recorder, runId, 'review-queue', '1.0.0', async () => {
      const flagged = this.reviewCount(documentHash);
      return stageResult(null, { outputCount: flagged, flaggedCount: flagged });
    });
  }

  resolveAccountForHint(accountHint: string, documentHash?: string): string | null {
    const accounts = this.db.prepare('SELECT id, name, aliases FROM accounts WHERE household_id = ?').all(hh()) as Array<{
      id: string;
      name: string;
      aliases: string;
    }>;
    let filename: string | undefined;
    if (documentHash) {
      const doc = this.db.prepare('SELECT filename FROM raw_documents WHERE hash = ?').get(documentHash) as
        | { filename: string }
        | undefined;
      filename = doc?.filename;
    }
    return resolveAccountId({
      hint: accountHint,
      accounts,
      filename,
      mappings: this.accountMappings,
    });
  }

  private async resolveAccount(accountHint: string, documentHash?: string): Promise<string | null> {
    return this.resolveAccountForHint(accountHint, documentHash);
  }

  private async matchOrCreateTransaction(
    obs: { id: string; account_hint: string; timestamp: number; amount_cents: number; merchant_text: string; kind: string; currency: string; fx_currency: string | null; adapter_name: string; is_statement?: number },
    accountId: string,
    adapterName: string
  ): Promise<{ transactionId: string | null; created: boolean; merged: boolean }> {
    const isStatement = obs.is_statement === 1;
    const isAlertAdapter = !isStatement && (adapterName.startsWith('email-') || adapterName.includes('alert'));
    
    if (isAlertAdapter) {
      const recentObservations = this.db.prepare(`
        SELECT id, timestamp, currency, fx_amount_cents, fx_currency, reference, kind FROM observations
        WHERE household_id = ?
          AND account_hint = ?
          AND amount_cents = ?
          AND merchant_text = ?
          AND timestamp = ?
          AND currency = ?
          AND id != ?
      `).all(
        hh(),
        obs.account_hint,
        obs.amount_cents,
        obs.merchant_text,
        obs.timestamp,
        obs.currency,
        obs.id
      ) as Array<{ id: string; timestamp: number; currency: string; fx_amount_cents: number | null; fx_currency: string | null; reference: string | null; kind: string }>;

      const identicalDuplicate = recentObservations.find(recent => {
        return recent.timestamp === obs.timestamp &&
               recent.currency === obs.currency &&
               recent.kind === obs.kind;
      });

      if (identicalDuplicate) {
        return { transactionId: null, created: false, merged: false };
      }
    }

    let windowStart: number;
    let windowEnd: number;
    
    if (isStatement) {
      windowStart = obs.timestamp - 3 * 24 * 60 * 60 * 1000;
      windowEnd = obs.timestamp + 1 * 24 * 60 * 60 * 1000;
    } else {
      windowStart = obs.timestamp - 1 * 24 * 60 * 60 * 1000;
      windowEnd = obs.timestamp + 3 * 24 * 60 * 60 * 1000;
    }
    
    const isForeignCurrency = obs.fx_currency !== null || obs.currency !== 'SGD';
    const amountTolerance = isForeignCurrency ? Math.abs(obs.amount_cents) * 0.03 : 1;
    
    const sameSign = obs.amount_cents < 0 ? 'amount_cents < 0' : 'amount_cents > 0';

    const candidates = this.db
      .prepare(`
        SELECT id, timestamp, amount_cents, merchant_text, observation_ids, state FROM transactions
        WHERE household_id = ?
          AND account_id = ?
          AND timestamp BETWEEN ? AND ?
          AND ABS(amount_cents - ?) <= ?
          AND ${sameSign}
          AND merchant_text LIKE ?
        ORDER BY ABS(timestamp - ?) ASC
      `)
      .all(
        hh(),
        accountId,
        windowStart,
        windowEnd,
        obs.amount_cents,
        amountTolerance,
        `%${obs.merchant_text.substring(0, 20)}%`,
        obs.timestamp
      ) as Array<{ id: string; timestamp: number; amount_cents: number; merchant_text: string; observation_ids: string; state: string }>;
    
    const filteredCandidates = candidates.filter(candidate => {
      const existingObsIds = JSON.parse(candidate.observation_ids) as string[];
      for (const existingObsId of existingObsIds) {
        const existingObs = this.db.prepare('SELECT adapter_name, is_statement FROM observations WHERE id = ?').get(existingObsId) as { adapter_name: string; is_statement: number } | undefined;
        if (existingObs) {
          const existingIsStatement = existingObs.is_statement === 1;
          const existingIsAlert = !existingIsStatement && (
            existingObs.adapter_name.startsWith('email-') || existingObs.adapter_name.includes('alert')
          );
          
          if ((isAlertAdapter && existingIsAlert) || (isStatement && existingIsStatement)) {
            return false;
          }
        }
      }
      return true;
    });

    if (filteredCandidates.length > 1) {
      this.db.prepare(`
        INSERT INTO review_queue (id, household_id, observation_id, document_hash, reason, detail, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        crypto.randomBytes(8).toString('hex'),
        hh(),
        obs.id,
        null,
        'ambiguous_match',
        JSON.stringify({
          candidateCount: filteredCandidates.length,
          candidates: filteredCandidates.map(c => ({
            transactionId: c.id,
            timestamp: c.timestamp,
            amountCents: c.amount_cents,
            merchantText: c.merchant_text,
            daysDiff: Math.abs(c.timestamp - obs.timestamp) / (24 * 60 * 60 * 1000),
            amountDiffCents: Math.abs(c.amount_cents - obs.amount_cents),
          })),
          observationId: obs.id,
          observationTimestamp: obs.timestamp,
          observationAmount: obs.amount_cents,
        }),
        Date.now()
      );

      logger.info('Ambiguous match detected, sent to review queue', {
        observationId: obs.id,
        candidateCount: filteredCandidates.length,
      });

      return { transactionId: null, created: false, merged: false };
    }

    const existingTx = filteredCandidates[0];

    if (existingTx) {
      const observationIds = JSON.parse(existingTx.observation_ids) as string[];
      if (!observationIds.includes(obs.id)) {
        observationIds.push(obs.id);
        
        const wasFromAlert = existingTx.state === 'pending';
        const newState = (isStatement && wasFromAlert) ? 'posted' : existingTx.state;
        
        // Guard: state transitions require non-LLM source
        assertNotLLMSourced({ adapterName }, 'transaction merge and state update');
        
        this.db
          .prepare(`
            UPDATE transactions 
            SET observation_ids = ?,
                state = ?,
                updated_at = ?
            WHERE id = ? AND household_id = ?
          `)
          .run(JSON.stringify(observationIds), newState, Date.now(), existingTx.id, hh());

        return { transactionId: existingTx.id, created: false, merged: true };
      }
      return { transactionId: existingTx.id, created: false, merged: false };
    }

    // Guard: transaction creation requires non-LLM source
    assertNotLLMSourced({ adapterName }, 'transaction INSERT');
    
    const txId = crypto.randomBytes(8).toString('hex');
    const now = Date.now();
    const state = isStatement ? 'posted' : 'pending';

    this.db
      .prepare(`
        INSERT INTO transactions (
          id, household_id, account_id, amount_cents, currency, timestamp,
          merchant_text, state, observation_ids, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        txId,
        hh(),
        accountId,
        obs.amount_cents,
        obs.currency || 'SGD',
        obs.timestamp,
        obs.merchant_text,
        state,
        JSON.stringify([obs.id]),
        now,
        now
      );

    return { transactionId: txId, created: true, merged: false };
  }

  private addToReviewQueue(observationId: string, reason: string, detail: string, documentHash?: string): void {
    try {
      const id = crypto.randomBytes(8).toString('hex');
      this.db
        .prepare(`
          INSERT OR IGNORE INTO review_queue (id, household_id, observation_id, document_hash, reason, detail, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(id, hh(), observationId, documentHash ?? null, reason, detail, Date.now());
    } catch (error) {
      logger.warn('Failed to add to review queue', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async updateStatementPeriods(documentHash: string): Promise<number> {
    return this.reconciliationService.reconcileDocument(documentHash, 'adapter');
  }

  private async normalizeMerchant(transactionId: string): Promise<void> {
    const tx = this.db
      .prepare('SELECT merchant_text, normalized_merchant FROM transactions WHERE id = ?')
      .get(transactionId) as { merchant_text: string; normalized_merchant: string | null } | undefined;

    if (!tx || tx.normalized_merchant) {
      return;
    }

    try {
      const normalized = await this.merchantNormalizationService.normalizeMerchant(tx.merchant_text);
      
      if (normalized && normalized !== tx.merchant_text) {
        const normalizationRecord = this.db.prepare(
          'SELECT source FROM merchant_normalizations WHERE household_id = ? AND raw_merchant = ?'
        ).get(hh(), tx.merchant_text) as { source: string } | undefined;
        
        const source = normalizationRecord?.source === 'user' ? 'user' : 'llm';
        assertNotLLMSourced({ source, adapterName: 'merchant-normalization' }, 'normalized_merchant UPDATE');
        
        this.db
          .prepare('UPDATE transactions SET normalized_merchant = ?, updated_at = ? WHERE id = ?')
          .run(normalized, Date.now(), transactionId);
      }
    } catch (error) {
      // Item C: Log errors with full context instead of swallowing
      logger.error('Merchant normalization failed for transaction', {
        transactionId,
        merchantText: tx.merchant_text,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  }

  private async detectTransfers(_documentHash: string): Promise<number> {
    const result = this.transferService.detectAndLinkTransfers('rule');
    return result.reviewFlagged;
  }

  private async tryLLMFallbackParser(documentHash: string): Promise<void> {
    if (!this.llmProvider) {
      return;
    }

    const doc = this.db
      .prepare('SELECT * FROM raw_documents WHERE hash = ?')
      .get(documentHash) as { hash: string; filename: string } | undefined;

    if (!doc) {
      return;
    }

    logger.info('Attempting LLM fallback parser', { documentHash, filename: doc.filename });

    try {
      const content = await this.documentStore.retrieve(documentHash);
      if (!content) {
        logger.error('Document content not found for fallback parsing', { documentHash });
        return;
      }

      const observations = await this.llmFallbackParser.parseUnknownDocument(documentHash, content);

      logger.info('LLM fallback parser completed', {
        documentHash,
        observationCount: observations.length,
      });
    } catch (error) {
      logger.error('LLM fallback parser failed', {
        documentHash,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  }
}

export function preventLLMBalanceWrites(): never {
  throw new Error('CODE-LEVEL GUARD: LLM output cannot write account balances');
}

export function preventLLMAmountWrites(): never {
  throw new Error('CODE-LEVEL GUARD: LLM output cannot modify posted transaction amounts');
}

export function preventLLMReconciliationWrites(): never {
  throw new Error('CODE-LEVEL GUARD: LLM output cannot modify reconciliation status');
}
