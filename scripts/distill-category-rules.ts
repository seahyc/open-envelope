#!/usr/bin/env npx tsx
import { resolve } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { initDatabase } from '../src/server/db/database.js';
import { loadCategorySchema } from '../src/server/categoriser/schema.js';
import { MerchantMemory } from '../src/server/categoriser/memory.js';
import { writeDistilledRules } from '../src/server/categoriser/rules.js';
import { readCsv } from '../src/server/categoriser/csv.js';

function arg(flag: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index >= 0) return process.argv[index + 1];
  return fallback;
}

const schema = loadCategorySchema(resolve(arg('--categories', 'config/categories.default.json')!), { required: true });
const outPath = resolve(arg('--out', 'config/category-rules.distilled.txt')!);
const memoryPath = arg('--memory');
const tmp = mkdtempSync(join(tmpdir(), 'cat-distill-'));
const db = initDatabase(join(tmp, 'distill.db'), { quiet: true });
const memory = new MerchantMemory(db);
if (memoryPath) {
  memory.ingestCsv(readCsv(resolve(memoryPath)));
} else {
  memory.rebuildFromTransactions();
}
const text = writeDistilledRules(db, schema, outPath);
process.stdout.write(`${text}\n`);
db.close();
rmSync(tmp, { recursive: true, force: true });
