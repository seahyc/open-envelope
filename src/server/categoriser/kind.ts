import type { TransactionFacts } from './prompt.js';
import type { CategoryKind } from './schema.js';

const TRANSFER_RE = /\b(FAST\s+PAYMENT|PAYNOW|PAY[\s-]*NOW|GIRO|IBG|FUNDS?\s+TRANSFER|OWN\s+ACCOUNT|OWN\s+SAVINGS|CREDIT\s+CARD\s+PAYMENT|CARD\s+PAYMENT|INTERNAL\s+TRANSFER)\b/i;
const REFUND_RE = /\b(REFUND|REVERSAL|REVERSED|CHARGEBACK|CREDIT\s+NOTE|CR\s+NOTE)\b/i;
const CREDIT_RE = /\bCREDIT\b/i;
const CREDIT_CARD_RE = /\bCREDIT\s+CARD\b/i;
const INTEREST_RE = /\bINTEREST\b/i;
const FEE_RE = /\b(FEE|LATE\s+CHARGE|BANK\s+CHARGE|ANNUAL\s+FEE)\b/i;

export function deriveTransactionKind(txn: TransactionFacts): CategoryKind {
  const text = `${txn.merchant} ${txn.memo ?? ''}`;
  if (TRANSFER_RE.test(text)) return 'transfer';
  if (REFUND_RE.test(text)) return 'refund';
  if (INTEREST_RE.test(text)) return 'interest';
  if (FEE_RE.test(text)) return 'fee';
  if (txn.amountCents > 0 && CREDIT_RE.test(text) && !CREDIT_CARD_RE.test(text)) return 'refund';
  if (txn.amountCents > 0) return 'income';
  return 'expense';
}
