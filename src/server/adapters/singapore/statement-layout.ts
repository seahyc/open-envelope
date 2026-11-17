import type { ObservationKind } from '../../../shared/types.js';

export interface MoneyToken {
  cents: number;
  index: number;
  raw: string;
  inParens: boolean;
  cr: boolean;
}

const MONEY_PATTERN = /\((?:\s*)([\d,]+\.\d{2})(?:\s*)\)|([\d,]+\.\d{2})(?:\s*(CR))?/gi;

export function parseMoneyToCents(raw: string): number {
  const cleaned = raw.replace(/[(),\s]/g, '').replace(/CR$/i, '');
  const value = parseFloat(cleaned);
  if (Number.isNaN(value)) return 0;
  return Math.round(value * 100);
}

export function extractMoneyTokens(line: string): MoneyToken[] {
  const tokens: MoneyToken[] = [];
  const regex = new RegExp(MONEY_PATTERN.source, 'gi');
  let match: RegExpExecArray | null;
  while ((match = regex.exec(line)) !== null) {
    const inParens = match[1] !== undefined;
    const raw = match[0];
    const cr = Boolean(match[3]) || /\bCR\b/i.test(raw);
    tokens.push({
      cents: parseMoneyToCents(inParens ? match[1]! : match[2]!),
      index: match.index,
      raw,
      inParens,
      cr,
    });
  }
  return tokens;
}

export function isLayoutNoiseLine(line: string): boolean {
  const t = line.trim();
  if (!t) return true;
  if (/^\d{2}[\/\-\s]/.test(t)) return false;
  if (/^\d{2}[A-Z]{3}\b/i.test(t)) return false;

  return (
    /^page\s+\d+(\s+of\s+\d+)?\b/i.test(t) ||
    /^ocbc bank\b/i.test(t) ||
    /^dbs bank\b/i.test(t) ||
    /^posb\b/i.test(t) ||
    /^360 account\b/i.test(t) ||
    /^statement savings\b/i.test(t) ||
    /^supplementary retirement\b/i.test(t) ||
    /^srs account\b/i.test(t) ||
    /^statement of account\b/i.test(t) ||
    /^credit card statement\b/i.test(t) ||
    /^altitude\b/i.test(t) ||
    /^card no\.?:/i.test(t) ||
    /^statement date\s*$/i.test(t) ||
    /^payment due/i.test(t) ||
    /^account (number|no\.?)\b/i.test(t) ||
    /statement period/i.test(t) ||
    /^date\s+(value date\s+)?description/i.test(t) ||
    /withdrawal\s+deposit\s+balance/i.test(t) ||
    /deposit insurance/i.test(t) ||
    /cpf investment scheme/i.test(t) ||
    /singapore dollar deposits of non-bank/i.test(t) ||
    /singapore deposit insurance corporation/i.test(t) ||
    /this includes cpf/i.test(t) ||
    /foreign currency deposits, dual currency/i.test(t) ||
    /structured deposits and other investment/i.test(t) ||
    /scheme member by law/i.test(t) ||
    /www\.(ocbc|dbs|posb)\./i.test(t) ||
    /^member of (ocbc|dbs)/i.test(t) ||
    /^important notes?/i.test(t) ||
    /^please note/i.test(t)
  );
}

export function isOpeningBalanceLabel(text: string): boolean {
  return /balance\s*b\/f|bal\.?\s*brought\s+forward|balance\s+brought\s+forward|opening\s+balance/i.test(text);
}

export function isClosingBalanceLabel(text: string): boolean {
  return /balance\s*c\/f|bal\.?\s*carried\s+forward|balance\s+carried\s+forward|total\s+balance\s+carried\s+forward|closing\s+balance/i.test(text);
}

export function isNonTransactionLabel(text: string): boolean {
  return (
    isOpeningBalanceLabel(text) ||
    isClosingBalanceLabel(text) ||
    /last month'?s balance|previous balance|grand total|subtotal|(?:^|\b)totals?\b|total amount due|new balance|minimum payment|payment due date|payment due\b/i.test(
      text
    )
  );
}

export function isCardSummaryLine(line: string): boolean {
  const t = line.trim();
  return /^(previous balance|grand total|totals?:|subtotal|new balance|last month'?s balance|total amount due|minimum payment)\b/i.test(
    t
  );
}

export function hasPrefixedCurrencyAmount(line: string): boolean {
  return /(?:S\$|\$)\s*[\d,]/.test(line);
}

export function isDbsCardTableHeader(line: string): boolean {
  const t = line.trim();
  return (
    /trans(?:action)?\s+date/i.test(t) ||
    (/post\s+date/i.test(t) && /description/i.test(t)) ||
    /^date\s+description/i.test(t)
  );
}

export function isOcbcCardTableHeader(line: string): boolean {
  return /transaction\s+date/i.test(line) && /amount\s*\(?\s*sgd/i.test(line);
}

export function headerRegion(text: string, maxLines = 50): string {
  const pages = text.split(/page\s+\d+\s+of\s+\d+/i);
  return pages
    .map((page) => {
      const beforeFooter = page.split(/deposit insurance/i)[0] ?? page;
      return beforeFooter
        .split(/\r?\n/)
        .filter((line) => {
          const t = line.trim();
          return !/cpf investment scheme|singapore dollar deposits of non-bank|singapore deposit insurance|this includes cpf|foreign currency deposits, dual currency|structured deposits and other investment|scheme member by law/i.test(
            t
          );
        })
        .slice(0, maxLines)
        .join('\n');
    })
    .join('\n');
}

export interface AmountColumns {
  withdrawal: number;
  deposit: number;
  balance: number;
}

export function detectAmountColumns(text: string): AmountColumns | null {
  for (const line of text.split(/\r?\n/)) {
    const withdrawal = line.search(/\bWithdrawal\b/i);
    const deposit = line.search(/\bDeposit\b/i);
    const balance = line.search(/\bBalance\b/i);
    if (withdrawal >= 0 && deposit >= 0 && balance >= 0 && withdrawal < deposit && deposit < balance) {
      return { withdrawal, deposit, balance };
    }
  }
  return null;
}

export function classifyMoneyColumn(
  index: number,
  columns: AmountColumns | null
): 'withdrawal' | 'deposit' | 'balance' | 'other' {
  if (!columns) return 'other';
  const midWithdrawalDeposit = (columns.withdrawal + columns.deposit) / 2;
  const midDepositBalance = (columns.deposit + columns.balance) / 2;
  if (index >= midDepositBalance) return 'balance';
  if (index >= midWithdrawalDeposit) return 'deposit';
  if (index >= columns.withdrawal - 4) return 'withdrawal';
  return 'other';
}

export function lastMoneyAfterLabel(text: string, label: RegExp): number | null {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!label.test(lines[i]!)) continue;
    let tokens = extractMoneyTokens(lines[i]!);
    if (tokens.length === 0 && lines[i + 1]) {
      const next = lines[i + 1]!;
      if (/^\s*\d{2}(?:[\/\-]|[A-Z]{3}|\s+[A-Z]{3})/i.test(next)) continue;
      tokens = extractMoneyTokens(next);
    }
    if (tokens.length === 0) continue;
    return tokens[tokens.length - 1]!.cents;
  }
  return null;
}

export function collectContinuation(
  lines: string[],
  startIndex: number,
  isNextRow: (line: string) => boolean,
  maxLines = 4
): { text: string; nextIndex: number } {
  const parts: string[] = [];
  let i = startIndex;
  let taken = 0;
  while (i < lines.length && taken < maxLines) {
    const line = lines[i]!;
    if (!line.trim()) {
      i += 1;
      continue;
    }
    if (isLayoutNoiseLine(line)) {
      i += 1;
      continue;
    }
    if (isNextRow(line)) break;
    if (isNonTransactionLabel(line) || isOpeningBalanceLabel(line) || isClosingBalanceLabel(line)) {
      break;
    }
    parts.push(line.trim());
    taken += 1;
    i += 1;
  }
  return { text: parts.join(' '), nextIndex: i };
}

export function kindFromBankDescription(description: string, amountCents: number): ObservationKind {
  const text = description.toLowerCase();
  if (/interest/.test(text)) return 'interest';
  if (/giro/.test(text)) return 'giro';
  if (/paynow|fast\s+(payment|collection|transfer)|transfer/.test(text)) return 'transfer';
  if (/fee|charge/.test(text) && amountCents < 0) return 'fee';
  return amountCents < 0 ? 'withdrawal' : 'deposit';
}

export function last4FromDigits(value: string): string {
  const digits = value.replace(/\D/g, '');
  return digits.slice(-4);
}

export function stripAccountPunctuation(value: string): string {
  return value.replace(/\D/g, '');
}

export function firstMoneyOnLine(line: string): MoneyToken | undefined {
  return extractMoneyTokens(line)[0];
}

export function lastMoneyOnLine(line: string): MoneyToken | undefined {
  const tokens = extractMoneyTokens(line);
  return tokens[tokens.length - 1];
}
