import type Database from 'better-sqlite3';
import type { DocumentStore } from '../storage/document-store.js';
import type { ImportResult } from '../../shared/types.js';
import type { AdapterRegistry } from '../adapters/registry.js';
import type { PipelineService } from './pipeline-service.js';
import type { StatementPeriod } from '../adapters/adapter.js';
import crypto from 'crypto';
import { PipelineRecorder, timedStage } from '../pipeline/recorder.js';
import { defineStage } from '../pipeline/runner.js';
import { stageResult } from '../pipeline/stage.js';
import { LINEAR_STAGES } from '../pipeline/definition.js';
import { hh } from '../lib/tenancy.js';

function stageMeta(id: string): { name: string; version: string; description: string } {
  const node = LINEAR_STAGES.find((stage) => stage.id === id);
  return {
    name: node?.name ?? id,
    version: node?.version ?? '1.0.0',
    description: node?.description ?? id,
  };
}

export class ImportService {
  private recorder: PipelineRecorder;

  constructor(
    private db: Database.Database,
    private documentStore: DocumentStore,
    private registry: AdapterRegistry,
    private pipelineService: PipelineService
  ) {
    this.recorder = new PipelineRecorder(db);
  }

  async import(filename: string, content: Buffer): Promise<ImportResult> {
    const doc = await this.documentStore.store(filename, content);
    
    const existingDoc = this.db.prepare(
      'SELECT hash FROM raw_documents WHERE hash = ? AND household_id = ?'
    ).get(doc.hash, hh()) as { hash: string } | undefined;

    if (existingDoc) {
      return {
        documentHash: doc.hash,
        observationsCreated: 0,
        observationsDuplicate: 0,
        transactionsCreated: 0,
        transactionsMerged: 0,
        errors: [],
      };
    }

    const runId = this.recorder.beginRun(filename, doc.hash);

    const ctx = { runId, documentHash: doc.hash, filename };
    const ingest = defineStage(stageMeta('ingest'), async () => {
      this.db.prepare(`
        INSERT INTO raw_documents (hash, household_id, filename, mime_type, uploaded_at, size_bytes)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(doc.hash, hh(), doc.filename, doc.mimeType, doc.uploadedAt, doc.sizeBytes);
      return stageResult(doc.hash, { inputCount: 1, outputCount: 1 });
    });
    await timedStage(this.recorder, runId, ingest.name, ingest.version, () => ingest.run(null, ctx));

    const bestMatch = await this.registry.findBestAdapter(content, filename, doc.mimeType);
    const detect = defineStage(stageMeta('detect-format'), async () => {
      return stageResult(bestMatch?.adapter.name ?? null, {
        inputCount: 1,
        outputCount: bestMatch ? 1 : 0,
        adapterName: bestMatch?.adapter.name,
        errorCount: bestMatch ? 0 : 1,
        errors: bestMatch ? [] : ['No adapter found'],
      });
    });
    await timedStage(this.recorder, runId, detect.name, detect.version, () => detect.run(null, ctx));
    
    if (!bestMatch) {
      const pipelineResult = await this.pipelineService.processDocument(doc.hash, { runId });
      this.recorder.finishRun(runId, 'error', {
        documentHash: doc.hash,
        errorCount: 1,
        transactionsCreated: pipelineResult.transactionsCreated,
        transactionsMerged: pipelineResult.transactionsMerged,
      });
      return {
        documentHash: doc.hash,
        observationsCreated: 0,
        observationsDuplicate: 0,
        transactionsCreated: pipelineResult.transactionsCreated,
        transactionsMerged: pipelineResult.transactionsMerged,
        errors: ['No adapter found'],
      };
    }

    const adapter = bestMatch.adapter;
    
    if (!adapter) {
      return {
        documentHash: doc.hash,
        observationsCreated: 0,
        observationsDuplicate: 0,
        transactionsCreated: 0,
        transactionsMerged: 0,
        errors: [`No adapter found for MIME type: ${doc.mimeType}`],
      };
    }

    try {
      const parse = defineStage(stageMeta('parse'), async () => {
        const parseResult = await adapter.parse(content, doc.hash);
        const observations = Array.isArray(parseResult) ? parseResult : parseResult.observations;
        const parsedPeriods: StatementPeriod[] = [];
        if (!Array.isArray(parseResult)) {
          if (parseResult.statementPeriods) {
            parsedPeriods.push(...parseResult.statementPeriods);
          } else if (parseResult.statementPeriod) {
            parsedPeriods.push(parseResult.statementPeriod);
          }
        }
        return stageResult({ observations, periods: parsedPeriods }, {
          inputCount: 1,
          outputCount: observations.length,
          adapterName: adapter.name,
        });
      });
      const parseOutcome = await timedStage(this.recorder, runId, parse.name, parse.version, () => parse.run(null, ctx));
      const parsedObservations = parseOutcome.output.observations;
      const periods = parseOutcome.output.periods;
      
      let created = 0;
      let duplicate = 0;

      const errors: string[] = [];

      for (const statementPeriod of periods) {
        const hint = statementPeriod.accountHint || parsedObservations[0]?.accountHint || '';
        const accountId = this.pipelineService.resolveAccountForHint(hint, doc.hash);
        
        if (accountId) {
          const periodId = crypto.randomBytes(8).toString('hex');
          this.db.prepare(`
            INSERT INTO statement_periods (
              id, account_id, start_date, end_date,
              opening_balance_cents, closing_balance_cents,
              document_hash, status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            periodId,
            accountId,
            statementPeriod.startDate,
            statementPeriod.endDate,
            statementPeriod.openingBalanceCents,
            statementPeriod.closingBalanceCents,
            doc.hash,
            'balanced',
            Date.now()
          );
        }

        if (
          parsedObservations.length === 0 &&
          statementPeriod.openingBalanceCents !== statementPeriod.closingBalanceCents
        ) {
          const message = 'adapter matched but parsed 0 lines while balances differ';
          errors.push(message);
          this.db.prepare(`
            INSERT INTO review_queue (id, observation_id, document_hash, reason, detail, created_at)
            VALUES (?, NULL, ?, ?, ?, ?)
          `).run(
            crypto.randomBytes(8).toString('hex'),
            doc.hash,
            'adapter_zero_lines_balance_mismatch',
            message,
            Date.now()
          );
        }
      }

      const insertObservation = this.db.prepare(`
        INSERT INTO observations (
          id, document_hash, account_hint, amount_cents, currency,
          fx_amount_cents, fx_currency, timestamp, merchant_text,
          reference, kind, adapter_name, is_statement, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const isCpf = adapter.name === 'cpf';
      if (isCpf) {
        this.db.prepare('BEGIN').run();
      }

      try {
        for (const obs of parsedObservations) {
          const id = this.createObservationId(
            doc.hash,
            obs.accountHint,
            obs.timestamp,
            obs.amountCents,
            obs.merchantText,
            obs.lineOrdinal
          );

          const existing = this.db.prepare(
            'SELECT id FROM observations WHERE id = ?'
          ).get(id) as { id: string } | undefined;

          if (existing) {
            duplicate++;
            continue;
          }

          insertObservation.run(
            id,
            doc.hash,
            obs.accountHint,
            obs.amountCents,
            obs.currency,
            obs.fxAmountCents ?? null,
            obs.fxCurrency ?? null,
            obs.timestamp,
            obs.merchantText,
            obs.reference ?? null,
            obs.kind,
            obs.adapterName,
            obs.isStatement ? 1 : 0,
            Date.now()
          );

          created++;
        }
        
        if (isCpf) {
          this.db.prepare('COMMIT').run();
        }
      } catch (txError) {
        if (isCpf) {
          this.db.prepare('ROLLBACK').run();
        }
        throw txError;
      }

      const upsert = defineStage(stageMeta('upsert'), async () => {
        return stageResult(null, {
          inputCount: parsedObservations.length,
          outputCount: created,
          adapterName: adapter.name,
        });
      });
      await timedStage(this.recorder, runId, upsert.name, upsert.version, () => upsert.run(null, ctx));

      const pipelineResult = await this.pipelineService.processDocument(doc.hash, {
        skipLlmFallback: periods.length > 0,
        runId,
      });

      this.recorder.finishRun(runId, errors.length > 0 ? 'error' : 'success', {
        documentHash: doc.hash,
        adapterName: adapter.name,
        observationsCreated: created,
        transactionsCreated: pipelineResult.transactionsCreated,
        transactionsMerged: pipelineResult.transactionsMerged,
        errorCount: errors.length,
        flaggedCount: errors.length,
      });

      return {
        documentHash: doc.hash,
        observationsCreated: created,
        observationsDuplicate: duplicate,
        transactionsCreated: pipelineResult.transactionsCreated,
        transactionsMerged: pipelineResult.transactionsMerged,
        errors,
        adapterName: adapter.name,
        hasStatementPeriod: periods.length > 0,
      };
    } catch (error) {
      this.recorder.finishRun(runId, 'error', {
        documentHash: doc.hash,
        adapterName: adapter.name,
        errorCount: 1,
      });
      return {
        documentHash: doc.hash,
        observationsCreated: 0,
        observationsDuplicate: 0,
        transactionsCreated: 0,
        transactionsMerged: 0,
        errors: [error instanceof Error ? error.message : String(error)],
      };
    }
  }

  private createObservationId(
    documentHash: string,
    accountHint: string,
    timestamp: number,
    amountCents: number,
    merchantText: string,
    lineOrdinal?: number
  ): string {
    const ordinal = lineOrdinal !== undefined ? `${lineOrdinal}:` : '';
    const data = `${documentHash}:${ordinal}${accountHint}:${timestamp}:${amountCents}:${merchantText}`;
    return crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);
  }
}
