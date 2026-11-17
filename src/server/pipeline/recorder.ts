import type Database from 'better-sqlite3';
import crypto from 'crypto';
import type { StageResult } from './stage.js';
import { hh } from '../lib/tenancy.js';

export interface PipelineRunRow {
  id: string;
  document_hash: string | null;
  filename: string | null;
  adapter_name: string | null;
  started_at: number;
  finished_at: number | null;
  status: string;
  observations_created: number;
  transactions_created: number;
  transactions_merged: number;
  error_count: number;
  flagged_count: number;
}

export interface StageRunRow {
  id: string;
  pipeline_run_id: string;
  stage_name: string;
  stage_version: string;
  adapter_name: string | null;
  started_at: number;
  duration_ms: number;
  input_count: number;
  output_count: number;
  error_count: number;
  flagged_count: number;
  status: string;
  error_message: string | null;
}

export class PipelineRecorder {
  constructor(private db: Database.Database) {}

  beginRun(filename?: string, documentHash?: string): string {
    const id = crypto.randomBytes(8).toString('hex');
    this.db.prepare(`
      INSERT INTO pipeline_runs (
        id, household_id, document_hash, filename, adapter_name, started_at, status
      ) VALUES (?, ?, ?, ?, NULL, ?, 'running')
    `).run(id, hh(), documentHash ?? null, filename ?? null, Date.now());
    return id;
  }

  recordStage(
    runId: string,
    stageName: string,
    stageVersion: string,
    result: Pick<StageResult, 'inputCount' | 'outputCount' | 'errorCount' | 'flaggedCount' | 'adapterName' | 'errors'>,
    durationMs: number,
    startedAt = Date.now() - durationMs
  ): void {
    this.db.prepare(`
      INSERT INTO stage_runs (
        id, household_id, pipeline_run_id, stage_name, stage_version, adapter_name,
        started_at, duration_ms, input_count, output_count, error_count,
        flagged_count, status, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomBytes(8).toString('hex'),
      hh(),
      runId,
      stageName,
      stageVersion,
      result.adapterName ?? null,
      startedAt,
      durationMs,
      result.inputCount,
      result.outputCount,
      result.errorCount,
      result.flaggedCount,
      result.errorCount > 0 ? 'error' : 'success',
      result.errors[0] ?? null
    );
  }

  finishRun(
    runId: string,
    status: 'success' | 'error' | 'skipped',
    summary: {
      adapterName?: string;
      documentHash?: string;
      observationsCreated?: number;
      transactionsCreated?: number;
      transactionsMerged?: number;
      errorCount?: number;
      flaggedCount?: number;
    } = {}
  ): void {
    this.db.prepare(`
      UPDATE pipeline_runs SET
        finished_at = ?,
        status = ?,
        adapter_name = COALESCE(?, adapter_name),
        document_hash = COALESCE(?, document_hash),
        observations_created = ?,
        transactions_created = ?,
        transactions_merged = ?,
        error_count = ?,
        flagged_count = ?
      WHERE id = ? AND household_id = ?
    `).run(
      Date.now(),
      status,
      summary.adapterName ?? null,
      summary.documentHash ?? null,
      summary.observationsCreated ?? 0,
      summary.transactionsCreated ?? 0,
      summary.transactionsMerged ?? 0,
      summary.errorCount ?? 0,
      summary.flaggedCount ?? 0,
      runId,
      hh()
    );
  }

  listRuns(limit = 50): PipelineRunRow[] {
    return this.db.prepare(
      'SELECT * FROM pipeline_runs WHERE household_id = ? ORDER BY started_at DESC LIMIT ?'
    ).all(hh(), limit) as PipelineRunRow[];
  }

  getRun(runId: string): PipelineRunRow | undefined {
    return this.db.prepare('SELECT * FROM pipeline_runs WHERE id = ? AND household_id = ?').get(runId, hh()) as PipelineRunRow | undefined;
  }

  getStageRuns(runId: string): StageRunRow[] {
    return this.db.prepare(
      'SELECT * FROM stage_runs WHERE household_id = ? AND pipeline_run_id = ? ORDER BY started_at ASC'
    ).all(hh(), runId) as StageRunRow[];
  }
}

export async function timedStage<T>(
  recorder: PipelineRecorder,
  runId: string,
  stageName: string,
  stageVersion: string,
  fn: () => Promise<StageResult<T>> | StageResult<T>
): Promise<StageResult<T>> {
  const startedAt = Date.now();
  try {
    const result = await fn();
    recorder.recordStage(runId, stageName, stageVersion, result, Date.now() - startedAt, startedAt);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recorder.recordStage(
      runId,
      stageName,
      stageVersion,
      { inputCount: 0, outputCount: 0, errorCount: 1, flaggedCount: 0, errors: [message] },
      Date.now() - startedAt,
      startedAt
    );
    throw error;
  }
}
