import type Database from 'better-sqlite3';
import type { StatementPeriod } from '../../shared/types.js';
import crypto from 'crypto';
import { assertNotLLMSourced } from '../lib/llm-guards.js';
import { resolveAccountId, type AccountMappingLike, type AccountRow } from '../lib/account-resolve.js';

export type PeriodTxSource = 'document' | 'orphan';

export interface PeriodTransaction {
  id: string;
  amountCents: number;
  source: PeriodTxSource;
}

export interface ReconcilePeriodResult {
  success: boolean;
  discrepancyCents: number;
  status: 'balanced' | 'unbalanced';
  statementLineCount: number;
  transactionCount: number;
  documentTransactionCount: number;
}

export interface ReconcileAllResult {
  periods: number;
  balanced: number;
  unbalanced: number;
  reviewsUpserted: number;
  reviewsResolved: number;
}

export function endOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(23, 59, 59, 999);
  return date.getTime();
}

type PeriodRow = {
  id: string;
  account_id: string;
  start_date: number;
  end_date: number;
  opening_balance_cents: number;
  closing_balance_cents: number;
  document_hash: string | null;
};

export class ReconciliationService {
  constructor(
    private db: Database.Database,
    private accountMappings: AccountMappingLike[] = []
  ) {}

  createStatementPeriod(
    accountId: string,
    startDate: number,
    endDate: number,
    openingBalanceCents: number,
    closingBalanceCents: number,
    documentHash?: string,
    source: 'adapter' | 'user' | 'llm' | 'llm-fallback' | 'rule' = 'adapter'
  ): string {
    const id = crypto.randomBytes(8).toString('hex');
    
    assertNotLLMSourced({ source }, 'statement_periods INSERT');
    this.db.prepare(`
      INSERT INTO statement_periods (
        id, account_id, start_date, end_date,
        opening_balance_cents, closing_balance_cents,
        document_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      accountId,
      startDate,
      endDate,
      openingBalanceCents,
      closingBalanceCents,
      documentHash ?? null,
      Date.now()
    );

    return id;
  }

  transactionsForPeriod(periodId: string): PeriodTransaction[] {
    const period = this.getPeriodRow(periodId);
    if (!period) {
      throw new Error('Statement period not found');
    }
    return this.transactionsForPeriodRow(period);
  }

  reconcilePeriod(periodId: string, source: 'user' | 'llm' | 'llm-fallback' | 'rule' | 'adapter' = 'user'): ReconcilePeriodResult {
    const period = this.getPeriodRow(periodId);
    if (!period) {
      throw new Error('Statement period not found');
    }
    return this.reconcilePeriodRow(period, source, { markTransactions: true });
  }

  reconcileDocument(documentHash: string, source: 'user' | 'llm' | 'llm-fallback' | 'rule' | 'adapter' = 'adapter'): number {
    const periods = this.db.prepare(
      'SELECT * FROM statement_periods WHERE document_hash = ?'
    ).all(documentHash) as PeriodRow[];

    let flagged = 0;
    for (const period of periods) {
      const result = this.reconcilePeriodRow(period, source, { markTransactions: false });
      if (!result.success) flagged += 1;
    }
    return flagged;
  }

  reconcileAllPeriods(source: 'user' | 'llm' | 'llm-fallback' | 'rule' | 'adapter' = 'adapter'): ReconcileAllResult {
    const periods = this.db.prepare(
      'SELECT * FROM statement_periods ORDER BY end_date ASC'
    ).all() as PeriodRow[];

    let balanced = 0;
    let unbalanced = 0;
    let reviewsUpserted = 0;
    let reviewsResolved = 0;

    for (const period of periods) {
      const before = this.unresolvedUnbalancedCount(period.id);
      const result = this.reconcilePeriodRow(period, source, { markTransactions: false });
      const after = this.unresolvedUnbalancedCount(period.id);
      if (result.success) {
        balanced += 1;
        reviewsResolved += Math.max(0, before - after);
      } else {
        unbalanced += 1;
        if (after > before) reviewsUpserted += after - before;
        else if (after === before && after === 0) reviewsUpserted += 1;
        reviewsResolved += Math.max(0, before - after);
      }
    }

    return {
      periods: periods.length,
      balanced,
      unbalanced,
      reviewsUpserted,
      reviewsResolved,
    };
  }

  getStatementPeriods(accountId: string): StatementPeriod[] {
    const rows = this.db.prepare(`
      SELECT * FROM statement_periods
      WHERE account_id = ?
      ORDER BY end_date DESC
    `).all(accountId) as Array<{
      id: string;
      account_id: string;
      start_date: number;
      end_date: number;
      opening_balance_cents: number;
      closing_balance_cents: number;
      document_hash: string | null;
      reconciled_at: number | null;
      discrepancy_cents: number | null;
      status: string;
      created_at: number;
    }>;

    return rows.map(row => ({
      id: row.id,
      accountId: row.account_id,
      startDate: row.start_date,
      endDate: row.end_date,
      openingBalanceCents: row.opening_balance_cents,
      closingBalanceCents: row.closing_balance_cents,
      documentHash: row.document_hash ?? undefined,
      reconciledAt: row.reconciled_at ?? undefined,
      discrepancyCents: row.discrepancy_cents ?? undefined,
      status: row.status === 'unbalanced' ? 'unbalanced' : 'balanced',
      createdAt: row.created_at,
    }));
  }

  private getPeriodRow(periodId: string): PeriodRow | undefined {
    return this.db.prepare(`
      SELECT id, account_id, start_date, end_date,
             opening_balance_cents, closing_balance_cents, document_hash
      FROM statement_periods WHERE id = ?
    `).get(periodId) as PeriodRow | undefined;
  }

  private transactionsForPeriodRow(period: PeriodRow): PeriodTransaction[] {
    const byId = new Map<string, PeriodTransaction>();

    if (period.document_hash) {
      const documentTxs = this.db.prepare(`
        SELECT DISTINCT t.id, t.amount_cents
        FROM transactions t
        JOIN json_each(t.observation_ids) je
        JOIN observations o ON o.id = je.value
        WHERE t.account_id = ?
          AND t.state IN ('posted', 'reconciled')
          AND o.document_hash = ?
      `).all(period.account_id, period.document_hash) as Array<{ id: string; amount_cents: number }>;

      for (const tx of documentTxs) {
        byId.set(tx.id, { id: tx.id, amountCents: tx.amount_cents, source: 'document' });
      }
    }

    const orphans = this.db.prepare(`
      SELECT t.id, t.amount_cents
      FROM transactions t
      WHERE t.account_id = ?
        AND t.state IN ('posted', 'reconciled')
        AND t.timestamp >= ?
        AND t.timestamp <= ?
        AND NOT EXISTS (
          SELECT 1
          FROM json_each(t.observation_ids) je
          JOIN observations o ON o.id = je.value
          JOIN statement_periods sp ON sp.document_hash = o.document_hash
        )
    `).all(period.account_id, period.start_date, endOfDay(period.end_date)) as Array<{
      id: string;
      amount_cents: number;
    }>;

    for (const tx of orphans) {
      if (!byId.has(tx.id)) {
        byId.set(tx.id, { id: tx.id, amountCents: tx.amount_cents, source: 'orphan' });
      }
    }

    return [...byId.values()];
  }

  private reconcilePeriodRow(
    period: PeriodRow,
    source: 'user' | 'llm' | 'llm-fallback' | 'rule' | 'adapter',
    options: { markTransactions: boolean }
  ): ReconcilePeriodResult {
    const txs = this.transactionsForPeriodRow(period);
    const txSum = txs.reduce((sum, tx) => sum + tx.amountCents, 0);
    const discrepancyCents = period.opening_balance_cents + txSum - period.closing_balance_cents;
    const documentTransactionCount = txs.filter((tx) => tx.source === 'document').length;
    const statementLineCount = this.statementLineCount(period);
    const compareLineCounts = statementLineCount > 0;
    const unbalanced =
      discrepancyCents !== 0 || (compareLineCounts && statementLineCount !== documentTransactionCount);
    const status: 'balanced' | 'unbalanced' = unbalanced ? 'unbalanced' : 'balanced';

    assertNotLLMSourced({ source }, 'statement_periods reconciled_at UPDATE');
    this.db.prepare(`
      UPDATE statement_periods
      SET reconciled_at = ?, discrepancy_cents = ?, status = ?
      WHERE id = ?
    `).run(Date.now(), discrepancyCents, status, period.id);

    if (!unbalanced && options.markTransactions) {
      assertNotLLMSourced({ source }, 'transactions state=reconciled UPDATE');
      const postedIds = txs.map((tx) => tx.id);
      if (postedIds.length > 0) {
        this.db.prepare(`
          UPDATE transactions
          SET state = 'reconciled'
          WHERE state = 'posted'
            AND id IN (${postedIds.map(() => '?').join(', ')})
        `).run(...postedIds);
      }
    }

    this.syncUnbalancedReview(period, unbalanced, {
      periodId: period.id,
      discrepancyCents,
      statementLineCount,
      transactionCount: txs.length,
      documentTransactionCount,
    });

    return {
      success: !unbalanced,
      discrepancyCents,
      status,
      statementLineCount,
      transactionCount: txs.length,
      documentTransactionCount,
    };
  }

  private statementLineCount(period: PeriodRow): number {
    if (!period.document_hash) return 0;

    const accounts = this.db.prepare('SELECT id, name, aliases FROM accounts').all() as AccountRow[];
    const doc = this.db.prepare('SELECT filename FROM raw_documents WHERE hash = ?').get(period.document_hash) as
      | { filename: string }
      | undefined;

    const statementObs = this.db.prepare(
      'SELECT account_hint FROM observations WHERE document_hash = ? AND is_statement = 1'
    ).all(period.document_hash) as Array<{ account_hint: string }>;

    return statementObs.filter((obs) => {
      const accountId = resolveAccountId({
        hint: obs.account_hint,
        accounts,
        filename: doc?.filename,
        mappings: this.accountMappings,
      });
      return accountId === period.account_id;
    }).length;
  }

  private unresolvedUnbalancedCount(periodId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as count FROM review_queue
      WHERE reason = 'unbalanced_period'
        AND resolved = 0
        AND (id = ? OR json_extract(detail, '$.periodId') = ?)
    `).get(this.unbalancedReviewId(periodId), periodId) as { count: number };
    return row.count;
  }

  private unbalancedReviewId(periodId: string): string {
    return `unbalanced-period:${periodId}`;
  }

  private syncUnbalancedReview(
    period: PeriodRow,
    unbalanced: boolean,
    detail: {
      periodId: string;
      discrepancyCents: number;
      statementLineCount: number;
      transactionCount: number;
      documentTransactionCount: number;
    }
  ): void {
    const stableId = this.unbalancedReviewId(period.id);
    const now = Date.now();

    if (unbalanced) {
      this.db.prepare(`
        INSERT INTO review_queue (
          id, observation_id, document_hash, reason, detail, created_at, resolved, resolved_at
        ) VALUES (?, NULL, ?, 'unbalanced_period', ?, ?, 0, NULL)
        ON CONFLICT(id) DO UPDATE SET
          detail = excluded.detail,
          document_hash = excluded.document_hash,
          resolved = 0,
          resolved_at = NULL
      `).run(stableId, period.document_hash, JSON.stringify(detail), now);
    }

    this.db.prepare(`
      UPDATE review_queue
      SET resolved = 1, resolved_at = ?
      WHERE reason = 'unbalanced_period'
        AND resolved = 0
        AND (id = ? OR json_extract(detail, '$.periodId') = ?)
        AND id != ?
    `).run(now, stableId, period.id, unbalanced ? stableId : '');

    if (!unbalanced) {
      this.db.prepare(`
        UPDATE review_queue
        SET resolved = 1, resolved_at = ?
        WHERE resolved = 0
          AND (
            id = ?
            OR (reason = 'unbalanced_period' AND json_extract(detail, '$.periodId') = ?)
          )
      `).run(now, stableId, period.id);
    }
  }
}
