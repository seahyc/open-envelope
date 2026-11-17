import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { initDatabase } from '../../src/server/db/database.js';
import { PipelineRecorder } from '../../src/server/pipeline/recorder.js';
import { defineStage, runStages } from '../../src/server/pipeline/runner.js';
import { stageResult } from '../../src/server/pipeline/stage.js';

describe('declarative stage runner', () => {
  let tmpDir: string;
  let db: Database.Database;
  let recorder: PipelineRecorder;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pipeline-runner-'));
    db = initDatabase(join(tmpDir, 'test.db'));
    recorder = new PipelineRecorder(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs enabled stages in list order and skips disabled ones', async () => {
    const runId = recorder.beginRun('runner.csv', 'hash-runner');
    const seen: string[] = [];
    const stages = [
      defineStage({ name: 'first', version: '1.0.0', description: 'one' }, (input: number) => {
        seen.push('first');
        return stageResult(input + 1, { inputCount: 1, outputCount: 1 });
      }),
      defineStage({ name: 'skipped', version: '1.0.0', enabled: false, description: 'off' }, (input: number) => {
        seen.push('skipped');
        return stageResult(input + 100, { inputCount: 1, outputCount: 1 });
      }),
      defineStage({ name: 'second', version: '1.0.0', description: 'two' }, (input: number) => {
        seen.push('second');
        return stageResult(input + 1, { inputCount: 1, outputCount: 1 });
      }),
    ];

    const output = await runStages(recorder, runId, stages, 0, { runId });
    expect(output).toBe(2);
    expect(seen).toEqual(['first', 'second']);

    const recorded = recorder.getStageRuns(runId).map((row) => row.stage_name);
    expect(recorded).toEqual(['first', 'second']);
  });
});
