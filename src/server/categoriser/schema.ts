import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export type CategoryKind = 'expense' | 'income' | 'transfer' | 'refund' | 'fee' | 'interest';

export interface CategoryNode {
  id: string;
  path: string[];
  description: string;
  kind: CategoryKind;
}

export interface CategorySchema {
  categories: CategoryNode[];
}

const KINDS = new Set<CategoryKind>(['expense', 'income', 'transfer', 'refund', 'fee', 'interest']);

export function defaultCategoriesPath(): string {
  return process.env.CATEGORIES_PATH || join(process.cwd(), 'config/categories.default.json');
}

export function loadCategorySchema(
  filePath = defaultCategoriesPath(),
  options: { required?: boolean } = {}
): CategorySchema {
  if (!existsSync(filePath)) {
    if (options.required) {
      throw new Error(`Category schema not found: ${filePath}`);
    }
    return { categories: [] };
  }
  const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as CategorySchema;
  if (!Array.isArray(parsed.categories) || parsed.categories.length === 0) {
    throw new Error('Category schema must list at least one category');
  }
  for (const category of parsed.categories) {
    if (!category.id || !Array.isArray(category.path) || category.path.length === 0) {
      throw new Error(`Invalid category: ${JSON.stringify(category)}`);
    }
    if (!KINDS.has(category.kind)) {
      throw new Error(`Unknown kind for ${category.id}: ${category.kind}`);
    }
  }
  return parsed;
}

export function l1Of(category: CategoryNode): string {
  return category.path[0]!;
}

export function levelOf(category: CategoryNode, depth: number): string | null {
  return category.path[depth] ?? null;
}

export function uniqueL1(schema: CategorySchema): Array<{ id: string; kind: CategoryKind; description: string }> {
  const seen = new Map<string, { id: string; kind: CategoryKind; description: string }>();
  for (const category of schema.categories) {
    const id = l1Of(category);
    if (!seen.has(id)) {
      seen.set(id, { id, kind: category.kind, description: `${id} (${category.kind})` });
    }
  }
  return [...seen.values()];
}

export function leavesUnderL1(schema: CategorySchema, l1: string): CategoryNode[] {
  return schema.categories.filter((category) => l1Of(category) === l1);
}

export function findCategory(schema: CategorySchema, id: string): CategoryNode | undefined {
  return schema.categories.find((category) => category.id === id);
}
