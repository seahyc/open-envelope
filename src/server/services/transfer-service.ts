import type Database from 'better-sqlite3';
import type { Transaction } from '../../shared/types.js';
import { assertNotLLMSourced } from '../lib/llm-guards.js';

export const TRANSFER_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;

const CARD_CREDIT_MERCHANT = /PAYMENT\s+RECEIVED|PAYMENT\s*[-–]\s*THANK|THANK\s+YOU/i;
const CARD_DEBIT_MERCHANT =
  /CARD\s+PAYMENT|CREDIT\s+CARD(?:\s+PAYMENT)?|PAYMENT\s+TO\s+\w+\s+CARD|(?:OCBC|DBS|POSB|UOB|CITI)\s+(?:CREDIT\s+)?CARD/i;
const OWN_RAIL = /\bFAST\b|\bPAYNOW\b|\bGIRO\b|TRANSFER\s+(?:TO|FROM|OUT|IN)\b/i;

export interface TransferDetectResult {
  linkedPairs: number;
  reviewFlagged: number;
  reviewsResolved: number;
}

type TxRow = {
  id: string;
  account_id: string;
  amount_cents: number;
  timestamp: number;
  merchant_text: string;
  observation_ids: string;
  account_group: string;
};

export function isCardBillPair(left: Pick<TxRow, 'account_group' | 'amount_cents' | 'merchant_text'>, right: Pick<TxRow, 'account_group' | 'amount_cents' | 'merchant_text'>): boolean {
  const debitCredit = (
    debit: Pick<TxRow, 'account_group' | 'amount_cents' | 'merchant_text'>,
    credit: Pick<TxRow, 'account_group' | 'amount_cents' | 'merchant_text'>
  ): boolean =>
    debit.account_group === 'budget' &&
    debit.amount_cents < 0 &&
    CARD_DEBIT_MERCHANT.test(debit.merchant_text) &&
    credit.account_group === 'credit' &&
    credit.amount_cents > 0 &&
    CARD_CREDIT_MERCHANT.test(credit.merchant_text);

  return debitCredit(left, right) || debitCredit(right, left);
}

export function isOwnRailPair(leftMerchant: string, rightMerchant: string): boolean {
  return OWN_RAIL.test(leftMerchant) && OWN_RAIL.test(rightMerchant);
}

export function isTransferLikePair(
  left: Pick<TxRow, 'account_group' | 'amount_cents' | 'merchant_text'>,
  right: Pick<TxRow, 'account_group' | 'amount_cents' | 'merchant_text'>
): boolean {
  return isCardBillPair(left, right) || isOwnRailPair(left.merchant_text, right.merchant_text);
}

export class TransferService {
  constructor(private db: Database.Database) {}

  detectAndLinkTransfers(source: 'rule' | 'user' | 'llm' | 'llm-fallback' | 'adapter' = 'rule'): TransferDetectResult {
    const txs = this.db.prepare(`
      SELECT t.id, t.account_id, t.amount_cents, t.timestamp, t.merchant_text,
             t.observation_ids, a.account_group
      FROM transactions t
      JOIN accounts a ON a.id = t.account_id
      WHERE t.linked_transaction_id IS NULL
        AND t.state IN ('posted', 'reconciled')
    `).all() as TxRow[];

    const linked = new Set<string>();

    const matesOf = (tx: TxRow): TxRow[] =>
      txs.filter(
        (other) =>
          other.id !== tx.id &&
          !linked.has(other.id) &&
          other.account_id !== tx.account_id &&
          other.amount_cents === -tx.amount_cents &&
          Math.abs(other.timestamp - tx.timestamp) <= TRANSFER_WINDOW_MS &&
          isTransferLikePair(tx, other)
      );

    let linkedPairs = 0;
    for (const tx of txs) {
      if (linked.has(tx.id)) continue;
      const mates = matesOf(tx);
      if (mates.length !== 1) continue;
      const mate = mates[0]!;
      if (linked.has(mate.id)) continue;
      const reverse = matesOf(mate);
      if (reverse.length !== 1 || reverse[0]!.id !== tx.id) continue;

      assertNotLLMSourced({ source }, 'transfer link UPDATE (1->2)');
      this.db.prepare(`
        UPDATE transactions SET linked_transaction_id = ? WHERE id = ?
      `).run(mate.id, tx.id);

      assertNotLLMSourced({ source }, 'transfer link UPDATE (2->1)');
      this.db.prepare(`
        UPDATE transactions SET linked_transaction_id = ? WHERE id = ?
      `).run(tx.id, mate.id);

      linked.add(tx.id);
      linked.add(mate.id);
      linkedPairs += 1;
    }

    let reviewFlagged = 0;
    const flaggedTxIds = new Set<string>();
    for (const tx of txs) {
      if (linked.has(tx.id) || flaggedTxIds.has(tx.id)) continue;
      const mates = matesOf(tx);
      if (mates.length === 0) continue;
      for (const node of [tx, ...mates]) {
        if (linked.has(node.id) || flaggedTxIds.has(node.id)) continue;
        flaggedTxIds.add(node.id);
        if (this.upsertPossibleTransferReview(node, matesOf(node).map((mate) => mate.id))) {
          reviewFlagged += 1;
        }
      }
    }

    const reviewsResolved = this.resolveStalePossibleTransferReviews(flaggedTxIds);
    return { linkedPairs, reviewFlagged, reviewsResolved };
  }

  getTransferPairs(): Array<{ tx1: Transaction; tx2: Transaction }> {
    const transactions = this.db.prepare(`
      SELECT * FROM transactions
      WHERE linked_transaction_id IS NOT NULL
      ORDER BY timestamp DESC
    `).all() as Array<{
      id: string;
      account_id: string;
      amount_cents: number;
      currency: string;
      fx_amount_cents: number | null;
      fx_currency: string | null;
      timestamp: number;
      merchant_text: string;
      state: string;
      category: string | null;
      envelope_id: string | null;
      linked_transaction_id: string | null;
      observation_ids: string;
      notes: string | null;
      created_at: number;
      updated_at: number;
    }>;

    const pairs: Array<{ tx1: Transaction; tx2: Transaction }> = [];
    const seen = new Set<string>();

    for (const tx of transactions) {
      if (seen.has(tx.id)) continue;
      if (!tx.linked_transaction_id) continue;

      const linked = transactions.find(t => t.id === tx.linked_transaction_id);
      if (!linked) continue;

      seen.add(tx.id);
      seen.add(linked.id);

      pairs.push({
        tx1: this.mapTransaction(tx),
        tx2: this.mapTransaction(linked),
      });
    }

    return pairs;
  }

  private possibleTransferReviewId(txId: string): string {
    return `possible-transfer:${txId}`;
  }

  private upsertPossibleTransferReview(tx: TxRow, mateIds: string[]): boolean {
    const ids = this.observationIds(tx.observation_ids);
    const observationId = ids[0] ?? null;
    const documentHash = this.documentHashForObservations(ids);
    const result = this.db.prepare(`
      INSERT INTO review_queue (
        id, observation_id, document_hash, reason, detail, created_at, resolved, resolved_at
      ) VALUES (?, ?, ?, 'possible_transfer', ?, ?, 0, NULL)
      ON CONFLICT(id) DO UPDATE SET
        detail = excluded.detail,
        observation_id = COALESCE(excluded.observation_id, review_queue.observation_id),
        document_hash = COALESCE(excluded.document_hash, review_queue.document_hash),
        resolved = 0,
        resolved_at = NULL
    `).run(
      this.possibleTransferReviewId(tx.id),
      observationId,
      documentHash,
      JSON.stringify({
        txId: tx.id,
        mateIds,
        amountCents: tx.amount_cents,
        merchantText: tx.merchant_text,
      }),
      Date.now()
    );
    return result.changes > 0;
  }

  private resolveStalePossibleTransferReviews(flaggedTxIds: Set<string>): number {
    const open = this.db.prepare(`
      SELECT id, observation_id, detail
      FROM review_queue
      WHERE reason = 'possible_transfer' AND resolved = 0
    `).all() as Array<{ id: string; observation_id: string | null; detail: string | null }>;

    if (open.length === 0) return 0;

    const txs = this.db.prepare(`
      SELECT id, observation_ids, linked_transaction_id FROM transactions
    `).all() as Array<{
      id: string;
      observation_ids: string;
      linked_transaction_id: string | null;
    }>;
    const byId = new Map(txs.map((tx) => [tx.id, tx]));

    const toResolve: string[] = [];
    for (const review of open) {
      const txIds = this.transactionIdsForReview(review, txs);
      const matched = txIds.map((id) => byId.get(id)).filter((tx): tx is typeof txs[number] => Boolean(tx));
      const linked = matched.some((tx) => Boolean(tx.linked_transaction_id));
      const flagged = txIds.some((id) => flaggedTxIds.has(id));
      if (txIds.length === 0 || linked || !flagged) {
        toResolve.push(review.id);
      }
    }

    if (toResolve.length === 0) return 0;
    const now = Date.now();
    this.db.prepare(`
      UPDATE review_queue
      SET resolved = 1, resolved_at = ?
      WHERE resolved = 0
        AND reason = 'possible_transfer'
        AND id IN (${toResolve.map(() => '?').join(', ')})
    `).run(now, ...toResolve);
    return toResolve.length;
  }

  private transactionIdsForReview(
    review: { id: string; observation_id: string | null; detail: string | null },
    txs: Array<{ id: string; observation_ids: string }>
  ): string[] {
    const ids = new Set<string>();
    const prefix = 'possible-transfer:';
    if (review.id.startsWith(prefix)) {
      ids.add(review.id.slice(prefix.length));
    }
    if (review.detail) {
      try {
        const parsed = JSON.parse(review.detail) as { txId?: unknown; transactionId?: unknown };
        if (typeof parsed === 'object' && parsed) {
          if (typeof parsed.txId === 'string' && parsed.txId) ids.add(parsed.txId);
          if (typeof parsed.transactionId === 'string' && parsed.transactionId) ids.add(parsed.transactionId);
        }
      } catch {
        // Legacy import stored a free-text sentence, not JSON.
      }
    }
    if (review.observation_id) {
      for (const tx of txs) {
        if (this.observationIds(tx.observation_ids).includes(review.observation_id)) {
          ids.add(tx.id);
        }
      }
    }
    return [...ids];
  }

  private observationIds(raw: string): string[] {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.map((value) => String(value)) : [];
    } catch {
      return [];
    }
  }

  private documentHashForObservations(ids: string[]): string | null {
    if (ids.length === 0) return null;
    const row = this.db.prepare(
      `SELECT document_hash FROM observations WHERE id IN (${ids.map(() => '?').join(', ')}) LIMIT 1`
    ).get(...ids) as { document_hash: string } | undefined;
    return row?.document_hash ?? null;
  }

  private mapTransaction(row: {
    id: string;
    account_id: string;
    amount_cents: number;
    currency: string;
    fx_amount_cents: number | null;
    fx_currency: string | null;
    timestamp: number;
    merchant_text: string;
    state: string;
    category: string | null;
    envelope_id: string | null;
    linked_transaction_id: string | null;
    observation_ids: string;
    notes: string | null;
    created_at: number;
    updated_at: number;
  }): Transaction {
    return {
      id: row.id,
      accountId: row.account_id,
      amountCents: row.amount_cents,
      currency: row.currency,
      fxAmountCents: row.fx_amount_cents ?? undefined,
      fxCurrency: row.fx_currency ?? undefined,
      timestamp: row.timestamp,
      merchantText: row.merchant_text,
      state: row.state as 'pending' | 'posted' | 'reconciled',
      category: row.category ?? undefined,
      envelopeId: row.envelope_id ?? undefined,
      linkedTransactionId: row.linked_transaction_id ?? undefined,
      observationIds: JSON.parse(row.observation_ids),
      notes: row.notes ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
