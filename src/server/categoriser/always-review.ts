import { logger } from '../lib/logger.js';
import type { TransactionFacts } from './prompt.js';

export function parseAlwaysReviewPatterns(raw = process.env.CATEGORISER_ALWAYS_REVIEW): RegExp[] {
  if (!raw || !raw.trim()) return [];
  const parts = raw.split(/[\n,]+/).map((part) => part.trim()).filter(Boolean);
  const patterns: RegExp[] = [];
  for (const part of parts) {
    try {
      patterns.push(new RegExp(part, 'i'));
    } catch {
      logger.warn('CATEGORISER_ALWAYS_REVIEW skipped invalid regex');
    }
  }
  return patterns;
}

export function matchesAlwaysReview(txn: TransactionFacts, patterns: RegExp[]): boolean {
  if (patterns.length === 0) return false;
  const haystack = `${txn.merchant}\n${txn.memo ?? ''}`;
  return patterns.some((pattern) => pattern.test(haystack));
}
