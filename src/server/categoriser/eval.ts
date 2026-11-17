import { findCategory, l1Of, type CategoryNode, type CategorySchema } from './schema.js';
import { deriveTransactionKind } from './kind.js';
import { redactErrorCode } from './errors.js';
import type { CategoriserService } from './service.js';
import type { CategoriserOutcome } from './service.js';

export { redactErrorCode } from './errors.js';

export interface EvalLine {
  id?: string;
  merchant?: string;
  account?: string;
  amount_cents?: string | number;
  memo?: string;
  category_id?: string;
}

export interface EvalLineError {
  line: string;
  code: string;
}

export interface EvalResult {
  provider: string;
  n: number;
  accuracy: { kind: number; L1: number; L2: number; L3: number; L4: number };
  autoAppliedPct: number;
  autoAppliedAccuracy: number;
  calibration: Record<string, { n: number; correct: number; accuracy: number }>;
  topConfusions: Array<[string, number]>;
  topConfusionsByAmount: Array<[string, number]>;
  tokensPerCall: number;
  avgTokens: number;
  maxTokens: number;
  runtimeMs: number;
  callsMade: number;
  errors: EvalLineError[];
}

export function scoreLevel(expected: CategoryNode, predicted: CategoryNode, depth: number): boolean {
  const expectedIndex = Math.min(depth, expected.path.length - 1);
  const predictedIndex = Math.min(depth, predicted.path.length - 1);
  return expected.path[expectedIndex] === predicted.path[predictedIndex];
}

export async function runCategoriserEval(options: {
  schema: CategorySchema;
  categoriser: CategoriserService;
  test: EvalLine[];
  providerName: string;
  onError?: (line: string, code: string) => void;
}): Promise<EvalResult> {
  const buckets = { '0-0.5': { n: 0, correct: 0 }, '0.5-0.8': { n: 0, correct: 0 }, '0.8-1': { n: 0, correct: 0 } };
  const confusion = new Map<string, number>();
  const confusionAmount = new Map<string, number>();
  const errors: EvalLineError[] = [];
  let kindOk = 0;
  let l1 = 0;
  let l2 = 0;
  let l3 = 0;
  let l4 = 0;
  let auto = 0;
  let autoOk = 0;
  let tokens = 0;
  let maxTokens = 0;
  let calls = 0;
  const started = Date.now();

  for (const row of options.test) {
    const lineId = row.id || 'unknown';
    const amountCents = Number(row.amount_cents || 0);
    const facts = {
      merchant: row.merchant ?? '',
      accountId: row.account,
      amountCents,
      memo: row.memo,
    };
    let outcome: CategoriserOutcome;
    try {
      outcome = await options.categoriser.categorizeFacts(facts);
    } catch (error) {
      const code = redactErrorCode(error);
      errors.push({ line: lineId, code });
      options.onError?.(lineId, code);
      continue;
    }
    if (outcome.errorCode) {
      errors.push({ line: lineId, code: outcome.errorCode });
      options.onError?.(lineId, outcome.errorCode);
    }
    const lineTokens = outcome.inputTokens + outcome.outputTokens;
    tokens += lineTokens;
    maxTokens = Math.max(maxTokens, lineTokens);
    calls += outcome.callsMade;
    const expected = findCategory(options.schema, row.category_id ?? '');
    const predicted = outcome.categoryId ? findCategory(options.schema, outcome.categoryId) : undefined;
    const expectedKind = deriveTransactionKind(facts);
    if (outcome.kind === expectedKind) kindOk += 1;
    if (expected && predicted && l1Of(expected) === l1Of(predicted)) l1 += 1;
    if (expected && predicted && scoreLevel(expected, predicted, 1)) l2 += 1;
    if (expected && predicted && scoreLevel(expected, predicted, 2)) l3 += 1;
    if (expected && predicted && scoreLevel(expected, predicted, 3)) l4 += 1;
    if (outcome.applied) {
      auto += 1;
      if (outcome.categoryId === row.category_id) autoOk += 1;
    }
    const bucket = outcome.confidence >= 0.8 ? '0.8-1' : outcome.confidence >= 0.5 ? '0.5-0.8' : '0-0.5';
    buckets[bucket].n += 1;
    if (outcome.categoryId === row.category_id) buckets[bucket].correct += 1;
    if (outcome.categoryId !== row.category_id) {
      const key = `${row.category_id} -> ${outcome.categoryId ?? 'none'}`;
      confusion.set(key, (confusion.get(key) ?? 0) + 1);
      confusionAmount.set(key, (confusionAmount.get(key) ?? 0) + Math.abs(amountCents));
    }
  }

  const n = options.test.length || 1;
  const scored = options.test.length;
  return {
    provider: options.providerName,
    n: options.test.length,
    accuracy: {
      kind: kindOk / n,
      L1: l1 / n,
      L2: l2 / n,
      L3: l3 / n,
      L4: l4 / n,
    },
    autoAppliedPct: auto / n,
    autoAppliedAccuracy: auto === 0 ? 0 : autoOk / auto,
    calibration: Object.fromEntries(
      Object.entries(buckets).map(([name, value]) => [name, { ...value, accuracy: value.n ? value.correct / value.n : 0 }])
    ),
    topConfusions: [...confusion.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
    topConfusionsByAmount: [...confusionAmount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
    tokensPerCall: calls === 0 ? 0 : tokens / calls,
    avgTokens: scored === 0 ? 0 : tokens / scored,
    maxTokens,
    runtimeMs: Date.now() - started,
    callsMade: calls,
    errors,
  };
}
