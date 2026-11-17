import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { initDatabase } from '../../src/server/db/database.js';
import { CategoriserService } from '../../src/server/categoriser/service.js';
import { loadCategorySchema } from '../../src/server/categoriser/schema.js';
import { runCategoriserEval, redactErrorCode, scoreLevel } from '../../src/server/categoriser/eval.js';
import { readCsv } from '../../src/server/categoriser/csv.js';

const schema = loadCategorySchema(join(process.cwd(), 'config/categories.default.json'), { required: true });

describe('categoriser eval harness', () => {
  it('scores the synthetic bake-off offline with memory-only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cat-eval-'));
    const out = join(dir, 'results.json');
    const stdout = execFileSync('npx', [
      'tsx',
      'scripts/eval-categoriser.ts',
      '--train',
      'fixtures/categoriser/train.csv',
      '--test',
      'fixtures/categoriser/test.csv',
      '--categories',
      'config/categories.default.json',
      '--memory',
      'fixtures/categoriser/merchants.csv',
      '--provider',
      'memory-only',
      '--out',
      out,
    ], { cwd: process.cwd(), encoding: 'utf-8' });
    expect(stdout).not.toMatch(/\[migrations\]/);
    const result = JSON.parse(readFileSync(out, 'utf-8')) as {
      n: number;
      callsMade: number;
      accuracy: { L1: number };
      autoAppliedPct: number;
      avgTokens: number;
      maxTokens: number;
      runtimeMs: number;
      topConfusionsByAmount: Array<[string, number]>;
    };
    expect(result.n).toBe(9);
    expect(result.callsMade).toBe(0);
    expect(result.accuracy.L1).toBeGreaterThan(0.4);
    expect(result.autoAppliedPct).toBeGreaterThan(0);
    expect(result.avgTokens).toBe(0);
    expect(result.maxTokens).toBe(0);
    expect(result.runtimeMs).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(result.topConfusionsByAmount)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('records a per-line error code and continues', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cat-eval-err-'));
    const db = initDatabase(join(dir, 'eval.db'), { quiet: true });
    const stderr: string[] = [];
    const categoriser = new CategoriserService(db, {
      schema,
      seedMemoryCsv: null,
      provider: {
        name: 'codex',
        async choose(_question, state) {
          if (state.includes('SECRETCAFE')) {
            throw new Error('CODEX_EXEC_FAILED Merchant: SECRETCAFE Amount: 99.00 Account: leak');
          }
          return {
            optionId: 'Transport',
            confidence: 0.9,
            probabilities: { Transport: 0.9 },
            rationale: 'ok',
            inputTokens: 10,
            outputTokens: 2,
          };
        },
      },
    });
    const result = await runCategoriserEval({
      schema,
      categoriser,
      providerName: 'codex',
      test: [
        { id: 'bad-1', merchant: 'SECRETCAFE', account: 'acc-joint', amount_cents: -9900, category_id: 'exp.food.dining.hawker' },
        { id: 'ok-2', merchant: 'UNKNOWN CAB', account: 'acc-joint', amount_cents: -1500, category_id: 'exp.transport.ride' },
      ],
      onError: (line, code) => {
        stderr.push(`${code} line=${line}`);
      },
    });
    expect(result.errors).toEqual([{ line: 'bad-1', code: 'CODEX_EXEC_FAILED' }]);
    expect(result.n).toBe(2);
    expect(result.callsMade).toBeGreaterThan(0);
    expect(stderr.join('\n')).toBe('CODEX_EXEC_FAILED line=bad-1');
    expect(stderr.join('\n')).not.toContain('SECRETCAFE');
    expect(stderr.join('\n')).not.toContain('99.00');
    expect(redactErrorCode(new Error('CODEX_EXEC_FAILED Merchant: SECRETCAFE'))).toBe('CODEX_EXEC_FAILED');
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('ranks confusions by amount and scores short-path leaves', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cat-eval-amt-'));
    const db = initDatabase(join(dir, 'eval.db'), { quiet: true });
    const categoriser = new CategoriserService(db, {
      schema,
      seedMemoryCsv: null,
      provider: {
        name: 'memory-only',
        async choose() { return null; },
      },
    });
    const result = await runCategoriserEval({
      schema,
      categoriser,
      providerName: 'memory-only',
      test: [
        { id: 'small', merchant: 'NOODLE HOUSE', amount_cents: -400, category_id: 'exp.food.dining.hawker' },
        { id: 'big', merchant: 'NOODLE HOUSE', amount_cents: -88000, category_id: 'exp.food.dining.hawker' },
      ],
    });
    expect(result.topConfusionsByAmount[0]?.[1]).toBe(88400);
    const short = { id: 'exp.misc', path: ['Miscellaneous'], description: 'misc', kind: 'expense' as const };
    expect(scoreLevel(short, short, 3)).toBe(true);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps distill migration logs off stdout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cat-distill-'));
    const out = join(dir, 'rules.txt');
    const stdout = execFileSync('npx', [
      'tsx',
      'scripts/distill-category-rules.ts',
      '--memory',
      'fixtures/categoriser/merchants.csv',
      '--categories',
      'config/categories.default.json',
      '--out',
      out,
    ], { cwd: process.cwd(), encoding: 'utf-8' });
    expect(stdout).not.toMatch(/\[migrations\]/);
    expect(readFileSync(out, 'utf-8')).toMatch(/GRAB|IRAS|Retail/i);
    rmSync(dir, { recursive: true, force: true });
  });
});
