import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { initDatabase } from '../../src/server/db/database.js';
import { loadCategorySchema, uniqueL1 } from '../../src/server/categoriser/schema.js';
import { MerchantMemory, memoryConfidence } from '../../src/server/categoriser/memory.js';
import { ExemplarStore } from '../../src/server/categoriser/exemplars.js';
import { distillRules, MAX_RULE_TOKENS } from '../../src/server/categoriser/rules.js';
import { estimateTokens, normalizeMerchantKey, shortMerchantKey } from '../../src/server/categoriser/normalize.js';
import { assemblePrompt, buildPromptParts, truncateParts } from '../../src/server/categoriser/prompt.js';
import { CategoriserService } from '../../src/server/categoriser/service.js';
import { deriveTransactionKind } from '../../src/server/categoriser/kind.js';
import { scoreLevel } from '../../src/server/categoriser/eval.js';
import { parseAlwaysReviewPatterns } from '../../src/server/categoriser/always-review.js';
import { codexChoiceSchema, createCategoriserProvider, providerConfigFromEnv } from '../../src/server/categoriser/providers.js';
import type { CategoriserProvider, ProviderDecision } from '../../src/server/categoriser/providers.js';
import { DEFAULT_CATEGORISER_AUTO_THRESHOLD, DEFAULT_CODEX_MODEL, DEFAULT_CODEX_REASONING_EFFORT, parseCodexExtraConfig } from '../../src/server/lib/codex-defaults.js';
import { readCsv } from '../../src/server/categoriser/csv.js';

const schema = loadCategorySchema(join(process.cwd(), 'config/categories.default.json'));

function fakeProvider(answers: string[]): CategoriserProvider {
  let i = 0;
  return {
    name: 'codex',
    async choose(_question, _state, options): Promise<ProviderDecision> {
      const optionId = answers[i++] ?? options[0]!.id;
      return {
        optionId,
        confidence: 0.91,
        probabilities: { [optionId]: 0.91 },
        rationale: 'fake',
        inputTokens: 12,
        outputTokens: 4,
      };
    },
  };
}

describe('small-context categoriser', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cat-'));
    db = initDatabase(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads the L1–L4 schema and kinds', () => {
    expect(schema.categories.length).toBeGreaterThan(8);
    expect(uniqueL1(schema).length).toBeLessThanOrEqual(10);
    expect(schema.categories.every((category) => category.path.length >= 1)).toBe(true);
  });

  it('auto-applies exact high-agreement memory and flags ask entries', () => {
    const memory = new MerchantMemory(db);
    memory.ingestCsv(readCsv(join(process.cwd(), 'fixtures/categoriser/merchants.csv')));
    const grab = memory.lookup('GRAB * RIDE ORCHARD');
    expect(grab?.categoryId).toBe('exp.transport.ride');
    expect(memory.highAgreement(grab!)).toBe(true);
    expect(memory.digest('GRAB * RIDE')).toMatch(/GRAB: 41×/);
    const ask = memory.lookup('ASK MERCHANT');
    expect(ask?.flagAsk).toBeTruthy();
  });

  it('distills condensed rules under the token budget', () => {
    const memory = new MerchantMemory(db);
    memory.ingestCsv(readCsv(join(process.cwd(), 'fixtures/categoriser/merchants.csv')));
    const rules = distillRules(db, schema);
    expect(estimateTokens(rules)).toBeLessThanOrEqual(MAX_RULE_TOKENS);
    expect(rules).toMatch(/IRAS|Income Tax|Retail/i);
  });

  it('retrieves similar exemplars and a canonical leaf example', () => {
    const store = new ExemplarStore(db);
    store.add({ merchant: 'GRAB RIDE', accountId: 'acc-joint', amountCents: -1200, memo: 'airport', categoryId: 'exp.transport.ride' });
    store.add({ merchant: 'FAIRPRICE', accountId: 'acc-joint', amountCents: -4000, memo: 'milk', categoryId: 'exp.food.groceries' });
    const similar = store.retrieveSimilar({
      merchant: 'GRAB * RIDE',
      accountId: 'acc-joint',
      amountCents: -1300,
      memo: 'airport',
      categoryId: '',
    });
    expect(similar[0]?.categoryId).toBe('exp.transport.ride');
    expect(store.canonicalFor('exp.food.groceries')?.merchantKey).toMatch(/FAIRPRICE/);
  });

  it('truncates prompt parts in a deterministic order', () => {
    const similar = Array.from({ length: 8 }, (_, index) => ({
      merchantKey: `M${index}`,
      accountId: 'a',
      amountCents: -100,
      memo: 'x'.repeat(200),
      categoryId: 'exp.retail.online',
      score: index,
    }));
    const parts = buildPromptParts(
      { merchant: 'AMAZON', amountCents: -1000, accountId: 'card', memo: 'order' },
      'Choose L1/kind',
      uniqueL1(schema).map((node) => ({ id: node.id, label: node.id, description: node.description })),
      '- rule '.repeat(80),
      ['GRAB: 41× Transport, 3× Food', 'AMAZON: 9× Retail'],
      similar,
      similar.slice(0, 3)
    );
    const truncated = truncateParts(parts, 200);
    const assembled = assemblePrompt(truncated, 200);
    expect(assembled.tokens).toBeLessThanOrEqual(200);
    expect(assembled.prompt).toContain('Merchant: AMAZON');
    expect(truncated.canonical).toHaveLength(0);
  });

  it('uses two provider steps and never writes balances', async () => {
    const categoriser = new CategoriserService(db, { schema, provider: fakeProvider(['Transport', 'exp.transport.ride']) });
    const outcome = await categoriser.categorizeFacts({
      merchant: 'UNKNOWN CAB',
      accountId: 'acc-joint',
      amountCents: -1500,
      memo: 'trip',
    });
    expect(outcome.source).toBe('provider');
    expect(outcome.categoryId).toBe('exp.transport.ride');
    expect(outcome.applied).toBe(true);
    expect(outcome.callsMade).toBe(2);
    expect(outcome.inputTokens).toBe(24);
    expect(outcome.kind).toBe('expense');
    expect(db.prepare('SELECT COUNT(*) as count FROM statement_periods').get() as { count: number }).toEqual({ count: 0 });
  });

  it('writes corrections back to memory and exemplars', () => {
    db.prepare(`
      INSERT INTO accounts (id, name, aliases, account_group, created_at)
      VALUES ('acc-joint', 'Joint', '[]', 'budget', ?)
    `).run(Date.now());
    db.prepare(`
      INSERT INTO transactions (
        id, account_id, amount_cents, currency, timestamp, merchant_text, state, observation_ids, created_at, updated_at
      ) VALUES ('tx1', 'acc-joint', -1250, 'SGD', ?, 'GRAB * RIDE', 'posted', '[]', ?, ?)
    `).run(Date.now(), Date.now(), Date.now());
    const categoriser = new CategoriserService(db, { schema, provider: { name: 'memory-only', async choose() { return null; } } });
    categoriser.recordCorrection('tx1', 'exp.transport.ride');
    expect(categoriser.memory.lookup('GRAB * RIDE')?.categoryId).toBe('exp.transport.ride');
    expect(categoriser.exemplars.canonicalFor('exp.transport.ride')?.merchantKey).toMatch(/GRAB/);
    const category = db.prepare('SELECT category FROM transactions WHERE id = ?').get('tx1') as { category: string };
    expect(category.category).toBe('exp.transport.ride');
  });

  it('strips numeric, location, and rail tokens and uses the PayNow payee as the key', () => {
    expect(normalizeMerchantKey('-1234 ACME HARDWARE SINGAPORE SG')).toBe('ACME HARDWARE');
    expect(shortMerchantKey('1234 ACME HARDWARE SINGAPORE SG')).toBe('ACME');
    expect(shortMerchantKey(normalizeMerchantKey('1234 ACME HARDWARE SINGAPORE SG'))).toBe('ACME');
    expect(normalizeMerchantKey('FAST PAYMENT | via PayNow-UEN to ALPHA')).toBe('ALPHA');
    expect(normalizeMerchantKey('GRAB* A-XYZ123 SINGAPORE')).toMatch(/^GRAB/);
    expect(normalizeMerchantKey('GRAB* A-XYZ123 SINGAPORE')).not.toContain('SINGAPORE');
  });

  it('does not auto-apply word-boundary bleed across shared location or rail tokens', async () => {
    const memory = new MerchantMemory(db);
    memory.add('-1234 ACME HARDWARE SINGAPORE SG', 'exp.retail.online', 5);
    memory.add('FAST PAYMENT | via PayNow-UEN to ALPHA', 'exp.transport.ride', 5);
    const noodle = memory.lookup('-1234 NOODLE HOUSE SINGAPORE SG');
    expect(noodle?.match === 'exact' || noodle?.match === 'short-key').toBeFalsy();
    expect(memory.canAutoApply(noodle ?? { match: 'word-boundary', flagAsk: false, total: 5, agreement: 1, merchantKey: '', categoryId: '', count: 5 })).toBe(false);
    const grab = memory.lookup('GRAB* A-XYZ123 SINGAPORE');
    expect(grab?.categoryId).not.toBe('exp.retail.online');
    const otherPayNow = memory.lookup('FAST PAYMENT | via PayNow-UEN to BETA TRAVEL');
    expect(otherPayNow?.categoryId).not.toBe('exp.transport.ride');
    expect(memory.lookup('FAST PAYMENT | via PayNow-UEN to ALPHA')?.categoryId).toBe('exp.transport.ride');
    expect(memory.canAutoApply(memory.lookup('FAST PAYMENT | via PayNow-UEN to ALPHA')!)).toBe(true);

    const categoriser = new CategoriserService(db, {
      schema,
      provider: { name: 'memory-only', async choose() { return null; } },
      seedMemoryCsv: null,
    });
    categoriser.memory.add('-1234 ACME HARDWARE SINGAPORE SG', 'exp.retail.online', 5);
    const leaked = await categoriser.categorizeFacts({
      merchant: '-1234 NOODLE HOUSE SINGAPORE SG',
      accountId: 'acc-joint',
      amountCents: -1800,
    });
    expect(leaked.applied).toBe(false);
    expect(leaked.categoryId).not.toBe('exp.retail.online');
  });

  it('reports weak-memory confidence from evidence, not 1.0', async () => {
    const categoriser = new CategoriserService(db, {
      schema,
      provider: { name: 'memory-only', async choose() { return null; } },
      seedMemoryCsv: null,
    });
    categoriser.memory.add('ONE OFF CAFE', 'exp.food.dining.hawker', 1);
    const hit = categoriser.memory.lookup('ONE OFF CAFE');
    expect(hit?.total).toBe(1);
    expect(memoryConfidence(hit!)).toBeCloseTo(1 / 3);
    const outcome = await categoriser.categorizeFacts({
      merchant: 'ONE OFF CAFE',
      accountId: 'acc-joint',
      amountCents: -800,
    });
    expect(outcome.applied).toBe(false);
    expect(outcome.review).toBe(true);
    expect(outcome.confidence).toBeCloseTo(1 / 3);
    expect(outcome.confidence).toBeLessThan(0.5);
  });

  it('derives kind from the transaction, not the category', async () => {
    expect(deriveTransactionKind({ merchant: 'ACME HARDWARE REFUND', amountCents: 1500 })).toBe('refund');
    expect(deriveTransactionKind({ merchant: 'BANK SERVICE FEE', amountCents: -250, memo: 'misc' })).toBe('fee');
    expect(deriveTransactionKind({ merchant: 'INTEREST CREDIT', amountCents: 182 })).toBe('interest');
    const categoriser = new CategoriserService(db, {
      schema,
      provider: fakeProvider(['Retail', 'exp.retail.online']),
      seedMemoryCsv: null,
    });
    const refund = await categoriser.categorizeFacts({
      merchant: 'ACME HARDWARE REFUND',
      accountId: 'acc-card',
      amountCents: 1500,
    });
    expect(refund.kind).toBe('refund');
    expect(refund.categoryId).toBeNull();
    expect(refund.rationale).toMatch(/direction guard/);
    const fee = await categoriser.categorizeFacts({
      merchant: 'BANK SERVICE FEE',
      accountId: 'acc-joint',
      amountCents: -250,
      memo: 'miscellaneous',
    });
    expect(fee.kind).toBe('fee');
  });

  it('starts without a categories file and can seed memory from an env CSV', async () => {
    const missing = join(tmpDir, 'missing-categories.json');
    const previousCategories = process.env.CATEGORIES_PATH;
    process.env.CATEGORIES_PATH = missing;
    try {
      expect(loadCategorySchema(missing).categories).toEqual([]);
      const empty = new CategoriserService(db, {
        provider: { name: 'none', async choose() { return null; } },
        seedMemoryCsv: null,
      });
      expect(empty.schema.categories).toEqual([]);
    } finally {
      if (previousCategories === undefined) delete process.env.CATEGORIES_PATH;
      else process.env.CATEGORIES_PATH = previousCategories;
    }

    const seedPath = join(tmpDir, 'memory-seed.csv');
    writeFileSync(seedPath, 'merchant_key,category_id,count,flag_ask\nGRAB,exp.transport.ride,5,0\n');
    const seeded = new CategoriserService(db, { schema, seedMemoryCsv: seedPath, provider: { name: 'memory-only', async choose() { return null; } } });
    const outcome = await seeded.categorizeFacts({
      merchant: 'GRAB * RIDE ORCHARD',
      accountId: 'acc-joint',
      amountCents: -1200,
    });
    expect(outcome.applied).toBe(true);
    expect(outcome.categoryId).toBe('exp.transport.ride');
    expect(outcome.source).toBe('memory');
  });

  it('uses a strict Codex output schema and reads model env', () => {
    const schemaJson = codexChoiceSchema(['exp.retail.online', 'exp.food.groceries']);
    expect(schemaJson.additionalProperties).toBe(false);
    expect(schemaJson.required).toEqual(['category', 'confidence', 'rationale']);
    const previousModel = process.env.CODEX_MODEL;
    const previousEffort = process.env.CODEX_REASONING_EFFORT;
    process.env.CODEX_MODEL = 'gpt-test';
    process.env.CODEX_REASONING_EFFORT = 'low';
    try {
      const config = providerConfigFromEnv();
      expect(config.codexModel).toBe('gpt-test');
      expect(config.codexReasoningEffort).toBe('low');
    } finally {
      if (previousModel === undefined) delete process.env.CODEX_MODEL;
      else process.env.CODEX_MODEL = previousModel;
      if (previousEffort === undefined) delete process.env.CODEX_REASONING_EFFORT;
      else process.env.CODEX_REASONING_EFFORT = previousEffort;
    }
  });

  it('defaults auto-threshold 0.9, Codex model, and reasoning effort', () => {
    const previousThreshold = process.env.CATEGORISER_AUTO_THRESHOLD;
    const previousModel = process.env.CODEX_MODEL;
    const previousEffort = process.env.CODEX_REASONING_EFFORT;
    const previousBin = process.env.CODEX_BIN;
    delete process.env.CATEGORISER_AUTO_THRESHOLD;
    delete process.env.CODEX_MODEL;
    delete process.env.CODEX_REASONING_EFFORT;
    delete process.env.CODEX_BIN;
    try {
      const categoriser = new CategoriserService(db, { schema, seedMemoryCsv: null, provider: { name: 'memory-only', async choose() { return null; } } });
      expect(categoriser.autoThreshold).toBe(DEFAULT_CATEGORISER_AUTO_THRESHOLD);
      expect(categoriser.autoThreshold).toBe(0.9);
      const config = providerConfigFromEnv();
      expect(config.codexModel).toBe(DEFAULT_CODEX_MODEL);
      expect(config.codexModel).toBe('gpt-6-luna');
      expect(config.codexReasoningEffort).toBe(DEFAULT_CODEX_REASONING_EFFORT);
      expect(createCategoriserProvider('codex').name).toBe('codex');
    } finally {
      if (previousThreshold === undefined) delete process.env.CATEGORISER_AUTO_THRESHOLD;
      else process.env.CATEGORISER_AUTO_THRESHOLD = previousThreshold;
      if (previousModel === undefined) delete process.env.CODEX_MODEL;
      else process.env.CODEX_MODEL = previousModel;
      if (previousEffort === undefined) delete process.env.CODEX_REASONING_EFFORT;
      else process.env.CODEX_REASONING_EFFORT = previousEffort;
      if (previousBin === undefined) delete process.env.CODEX_BIN;
      else process.env.CODEX_BIN = previousBin;
    }
  });

  it('does not auto-apply provider confidence below 0.9', async () => {
    const categoriser = new CategoriserService(db, {
      schema,
      seedMemoryCsv: null,
      provider: {
        name: 'codex',
        async choose(_q, _s, options) {
          const optionId = options[0]!.id;
          return {
            optionId,
            confidence: 0.85,
            probabilities: { [optionId]: 0.85 },
            rationale: 'borderline',
            inputTokens: 4,
            outputTokens: 2,
          };
        },
      },
    });
    const outcome = await categoriser.categorizeFacts({
      merchant: 'UNKNOWN CAB',
      accountId: 'acc-joint',
      amountCents: -1500,
    });
    expect(outcome.confidence).toBe(0.85);
    expect(outcome.applied).toBe(false);
    expect(outcome.review).toBe(true);
    expect(outcome.categoryId).toBeTruthy();
  });

  it('forces always-review while keeping the suggestion', async () => {
    const categoriser = new CategoriserService(db, {
      schema,
      seedMemoryCsv: null,
      alwaysReview: parseAlwaysReviewPatterns('PAYNOW,IRAS'),
      provider: fakeProvider(['Transport', 'exp.transport.ride']),
    });
    const outcome = await categoriser.categorizeFacts({
      merchant: 'FAST PAYMENT | via PayNow-UEN to ALPHA',
      accountId: 'acc-joint',
      amountCents: -2200,
    });
    expect(outcome.applied).toBe(false);
    expect(outcome.review).toBe(true);
    expect(outcome.categoryId).toBe('exp.transport.ride');
    expect(outcome.rationale).toMatch(/always-review/);
    expect(parseAlwaysReviewPatterns('')).toEqual([]);
    expect(parseAlwaysReviewPatterns('[unterminated')).toEqual([]);
  });

  it('sends a provider failure to review with no suggestion', async () => {
    const categoriser = new CategoriserService(db, {
      schema,
      seedMemoryCsv: null,
      provider: {
        name: 'codex',
        async choose() {
          throw new Error('CODEX_PARSE_FAILED');
        },
      },
    });
    const outcome = await categoriser.categorizeFacts({
      merchant: 'SECRETCAFE',
      accountId: 'acc-joint',
      amountCents: -9900,
    });
    expect(outcome.applied).toBe(false);
    expect(outcome.review).toBe(true);
    expect(outcome.categoryId).toBeNull();
    expect(outcome.errorCode).toBe('CODEX_PARSE_FAILED');
    expect(outcome.rationale).toBe('CODEX_PARSE_FAILED');
  });

  it('parses CODEX_EXTRA_CONFIG -c overrides', () => {
    expect(parseCodexExtraConfig('mcp_servers={},sandbox_mode=read-only')).toEqual([
      'mcp_servers={}',
      'sandbox_mode=read-only',
    ]);
    expect(parseCodexExtraConfig('["mcp_servers={}","features.mcp=false"]')).toEqual([
      'mcp_servers={}',
      'features.mcp=false',
    ]);
    expect(parseCodexExtraConfig('')).toEqual([]);
  });

  it('scores a short-path leaf at the category own depth', () => {
    const short = {
      id: 'exp.misc',
      path: ['Miscellaneous'],
      description: 'misc',
      kind: 'expense' as const,
    };
    const grocery = schema.categories.find((category) => category.id === 'exp.food.groceries')!;
    expect(scoreLevel(short, short, 3)).toBe(true);
    expect(scoreLevel(grocery, grocery, 3)).toBe(true);
    expect(scoreLevel(short, grocery, 3)).toBe(false);
  });
});
