#!/usr/bin/env npx tsx
/**
 * Categoriser bake-off harness (offline except the chosen provider).
 *
 * CSV columns (train + test):
 *   id,merchant,account,amount_cents,memo,category_id
 *
 * Merchant memory CSV (optional --memory):
 *   merchant_key,category_id,count,flag_ask
 *
 * Categories JSON:
 *   { "categories": [{ "id", "path": ["L1","L2",...], "description", "kind" }] }
 *
 * Usage:
 *   npx tsx scripts/eval-categoriser.ts --train fixtures/categoriser/train.csv \
 *     --test fixtures/categoriser/test.csv --categories config/categories.default.json \
 *     --provider memory-only --out /tmp/categoriser-results.json
 */
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { initDatabase } from '../src/server/db/database.js';
import { CategoriserService } from '../src/server/categoriser/service.js';
import { createCategoriserProvider, providerConfigFromEnv } from '../src/server/categoriser/providers.js';
import { loadCategorySchema } from '../src/server/categoriser/schema.js';
import { readCsv } from '../src/server/categoriser/csv.js';
import { runCategoriserEval } from '../src/server/categoriser/eval.js';

function arg(flag: string, fallback?: string): string {
  const index = process.argv.indexOf(flag);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (!value) throw new Error(`Missing ${flag}`);
  return value;
}

function optional(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const trainPath = resolve(arg('--train'));
  const testPath = resolve(arg('--test'));
  const categoriesPath = resolve(arg('--categories', 'config/categories.default.json'));
  const providerName = arg('--provider', 'memory-only');
  const outPath = resolve(arg('--out', 'categoriser-results.json'));
  const memoryPath = optional('--memory');

  const schema = loadCategorySchema(categoriesPath, { required: true });
  const tmp = mkdtempSync(join(tmpdir(), 'cat-eval-'));
  const db = initDatabase(join(tmp, 'eval.db'), { quiet: true });
  const categoriser = new CategoriserService(db, {
    schema,
    provider: createCategoriserProvider(providerName, providerConfigFromEnv()),
    seedMemoryCsv: null,
  });

  if (memoryPath) {
    categoriser.memory.ingestCsv(readCsv(resolve(memoryPath)));
  }

  const train = readCsv(trainPath);
  for (const row of train) {
    categoriser.memory.add(row.merchant ?? '', row.category_id ?? '', 1, row.category_id === 'flag');
    categoriser.exemplars.add({
      merchant: row.merchant ?? '',
      accountId: row.account,
      amountCents: Number(row.amount_cents || 0),
      memo: row.memo,
      categoryId: row.category_id ?? '',
      source: 'train',
    });
  }

  const result = await runCategoriserEval({
    schema,
    categoriser,
    test: readCsv(testPath),
    providerName,
    onError: (line, code) => {
      process.stderr.write(`${code} line=${line}\n`);
    },
  });

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  db.close();
  rmSync(tmp, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const code = /^[A-Z][A-Z0-9_]{2,}$/.test(message.split(/\s+/)[0] ?? '') ? message.split(/\s+/)[0] : 'EVAL_FAILED';
  process.stderr.write(`${code}\n`);
  process.exit(1);
});
