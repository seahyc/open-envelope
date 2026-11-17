import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type Database from 'better-sqlite3';
import { estimateTokens } from './normalize.js';
import type { CategorySchema } from './schema.js';
import { findCategory } from './schema.js';

export const MAX_RULE_TOKENS = 300;

export function defaultHandRulesPath(): string {
  return process.env.CATEGORY_RULES_PATH || join(process.cwd(), 'config/category-rules.md');
}

export function defaultDistilledRulesPath(): string {
  return process.env.CATEGORY_RULES_DISTILLED_PATH || join(process.cwd(), 'config/category-rules.distilled.txt');
}

export function loadHandRules(filePath = defaultHandRulesPath()): string {
  if (!existsSync(filePath)) return '';
  return readFileSync(filePath, 'utf-8')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('- '))
    .join('\n');
}

export function distillRules(db: Database.Database, schema: CategorySchema, handRules = loadHandRules()): string {
  const rows = db.prepare(`
    SELECT merchant_key, category_id, count
    FROM merchant_memory
    WHERE flag_ask = 0
    ORDER BY count DESC
  `).all() as Array<{ merchant_key: string; category_id: string; count: number }>;

  const perCategory = new Map<string, string[]>();
  for (const row of rows) {
    const category = findCategory(schema, row.category_id);
    const label = category ? category.path.join('/') : row.category_id;
    const list = perCategory.get(label) ?? [];
    if (list.length < 3) {
      list.push(`${row.merchant_key}×${row.count}`);
      perCategory.set(label, list);
    }
  }

  const distilledLines = [...perCategory.entries()].map(
    ([label, merchants]) => `- ${label}: ${merchants.join(', ')}`
  );
  const combined = [handRules.trim(), distilledLines.join('\n')].filter(Boolean).join('\n');
  return truncateRules(combined, MAX_RULE_TOKENS);
}

export function truncateRules(text: string, maxTokens = MAX_RULE_TOKENS): string {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const kept: string[] = [];
  for (const line of lines) {
    const next = [...kept, line].join('\n');
    if (estimateTokens(next) > maxTokens) break;
    kept.push(line);
  }
  return kept.join('\n');
}

export function writeDistilledRules(
  db: Database.Database,
  schema: CategorySchema,
  outPath = defaultDistilledRulesPath()
): string {
  const text = distillRules(db, schema);
  writeFileSync(outPath, `${text}\n`);
  return text;
}

export function loadCondensedRules(db: Database.Database, schema: CategorySchema): string {
  const distilledPath = defaultDistilledRulesPath();
  if (existsSync(distilledPath)) {
    return truncateRules(readFileSync(distilledPath, 'utf-8'), MAX_RULE_TOKENS);
  }
  return distillRules(db, schema);
}
