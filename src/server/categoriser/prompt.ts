import { estimateTokens } from './normalize.js';
import type { RetrievedExemplar } from './exemplars.js';

export const DEFAULT_TOKEN_BUDGET = 2000;

export interface TransactionFacts {
  merchant: string;
  accountId?: string | null;
  amountCents: number;
  memo?: string | null;
  enrichment?: string | null;
  ssicCode?: string | null;
  ssicDescription?: string | null;
  contextEvidence?: string | null;
}

export interface PromptOption {
  id: string;
  label: string;
  description: string;
}

export interface PromptParts {
  facts: string;
  question: string;
  options: string;
  rules: string;
  digests: string[];
  similar: string[];
  canonical: string[];
}

export function formatFacts(txn: TransactionFacts): string {
  const amount = (txn.amountCents / 100).toFixed(2);
  const lines = [
    `Merchant: ${txn.merchant}`,
    `Amount: ${amount}`,
    `Direction: ${txn.amountCents < 0 ? 'outflow' : txn.amountCents > 0 ? 'inflow' : 'zero'}`,
    `Account: ${txn.accountId || 'unknown'}`,
    `Memo: ${txn.memo || ''}`,
  ];
  if (txn.ssicCode) {
    lines.push(`SSIC: ${txn.ssicCode}${txn.ssicDescription ? ` ${txn.ssicDescription}` : ''}`);
  }
  if (txn.enrichment) lines.push(`Enrichment: ${txn.enrichment}`);
  if (txn.contextEvidence) lines.push(`Context: ${txn.contextEvidence}`);
  lines.push('Never assign an income category to an outflow, or an expense category to an inflow. Weigh SSIC family, direction, and amount.');
  return lines.join('\n');
}

export function formatOptions(options: PromptOption[]): string {
  return options.map((option) => `- ${option.id}: ${option.label} — ${option.description}`).join('\n');
}

export function formatExemplar(row: RetrievedExemplar): string {
  return `${row.merchantKey} ${row.amountCents} ${row.categoryId} ${row.memo}`.trim();
}

export function buildPromptParts(
  txn: TransactionFacts,
  question: string,
  options: PromptOption[],
  rules: string,
  digests: string[],
  similar: RetrievedExemplar[],
  canonical: RetrievedExemplar[]
): PromptParts {
  return {
    facts: formatFacts(txn),
    question,
    options: formatOptions(options),
    rules,
    digests,
    similar: similar.map(formatExemplar),
    canonical: canonical.map(formatExemplar),
  };
}

export function assemblePrompt(parts: PromptParts, budget = DEFAULT_TOKEN_BUDGET): { prompt: string; tokens: number } {
  const kept = truncateParts(parts, budget);
  const sections = [
    kept.facts,
    kept.question,
    `Options:\n${kept.options}`,
  ];
  if (kept.rules) sections.push(`Rules:\n${kept.rules}`);
  if (kept.digests.length) sections.push(`Merchant history:\n${kept.digests.join('\n')}`);
  if (kept.similar.length) sections.push(`Similar:\n${kept.similar.join('\n')}`);
  if (kept.canonical.length) sections.push(`Canonical:\n${kept.canonical.join('\n')}`);
  const prompt = sections.join('\n\n');
  return { prompt, tokens: estimateTokens(prompt) };
}

export function truncateParts(parts: PromptParts, budget = DEFAULT_TOKEN_BUDGET): PromptParts {
  const clone: PromptParts = {
    ...parts,
    digests: [...parts.digests],
    similar: [...parts.similar],
    canonical: [...parts.canonical],
  };
  const measure = () => estimateTokens(assembleWithoutBudget(clone));
  if (measure() <= budget) return clone;

  while (clone.canonical.length && measure() > budget) clone.canonical.pop();
  while (clone.similar.length > 5 && measure() > budget) clone.similar.pop();
  while (clone.similar.length && measure() > budget) clone.similar.pop();
  while (clone.digests.length > 1 && measure() > budget) clone.digests.pop();
  while (clone.digests.length && measure() > budget) clone.digests.pop();
  if (measure() > budget) {
    const lines = clone.rules.split(/\r?\n/).filter(Boolean);
    while (lines.length && measure() > budget) {
      lines.pop();
      clone.rules = lines.join('\n');
    }
  }
  return clone;
}

function assembleWithoutBudget(parts: PromptParts): string {
  return [
    parts.facts,
    parts.question,
    parts.options,
    parts.rules,
    ...parts.digests,
    ...parts.similar,
    ...parts.canonical,
  ].join('\n');
}
