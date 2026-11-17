import type Database from 'better-sqlite3';
import type { Transaction, TransactionState } from '../../shared/types.js';
import crypto from 'crypto';
import { assertNotLLMSourced } from '../lib/llm-guards.js';
import { hh } from '../lib/tenancy.js';

export class TransactionService {
  constructor(private db: Database.Database) {}

  processObservations(accountId: string): void {
    const account = this.db.prepare('SELECT aliases FROM accounts WHERE id = ? AND household_id = ?').get(accountId, hh()) as { aliases: string } | undefined;
    if (!account) return;
    
    const aliases = JSON.parse(account.aliases) as string[];
    
    const observations = this.db.prepare(`
      SELECT * FROM observations 
      WHERE household_id = ?
      AND account_hint IN (${aliases.map(() => '?').join(', ')})
      AND id NOT IN (
        SELECT json_each.value 
        FROM transactions, json_each(transactions.observation_ids)
        WHERE transactions.household_id = ?
      )
      ORDER BY timestamp ASC
    `).all(hh(), ...aliases, hh()) as Array<{
      id: string;
      document_hash: string;
      account_hint: string;
      amount_cents: number;
      currency: string;
      fx_amount_cents: number | null;
      fx_currency: string | null;
      timestamp: number;
      merchant_text: string;
      reference: string | null;
      kind: string;
      adapter_name: string;
      created_at: number;
    }>;

    for (const obs of observations) {
      const isEmailAlert = obs.adapter_name.startsWith('email-');
      
      if (isEmailAlert) {
        const existing = this.findMatchingTransaction(accountId, obs);
        
        if (existing) {
          this.updateTransaction(existing.id, {
            state: 'posted',
            observationIds: [...JSON.parse(existing.observation_ids), obs.id],
            adapterName: obs.adapter_name,
          });
        } else {
          this.createTransaction(accountId, obs, 'pending');
        }
      } else {
        const pending = this.findPendingMatch(accountId, obs);
        
        if (pending) {
          this.updateTransaction(pending.id, {
            state: 'posted',
            observationIds: [...JSON.parse(pending.observation_ids), obs.id],
            fxAmountCents: obs.fx_amount_cents,
            fxCurrency: obs.fx_currency,
            adapterName: obs.adapter_name,
          });
        } else {
          this.createTransaction(accountId, obs, 'posted');
        }
      }
    }

    this.flagUnpostedHolds(accountId);
  }

  private findMatchingTransaction(accountId: string, obs: {
    amount_cents: number;
    timestamp: number;
    merchant_text: string;
  }): { id: string; observation_ids: string } | undefined {
    const windowMs = 5 * 24 * 60 * 60 * 1000;
    const startWindow = obs.timestamp - windowMs;
    const endWindow = obs.timestamp + windowMs;

    return this.db.prepare(`
      SELECT id, observation_ids FROM transactions
      WHERE household_id = ?
      AND account_id = ?
      AND amount_cents = ?
      AND timestamp >= ?
      AND timestamp <= ?
      AND state IN ('pending', 'posted')
      ORDER BY ABS(timestamp - ?) ASC
      LIMIT 1
    `).get(hh(), accountId, obs.amount_cents, startWindow, endWindow, obs.timestamp) as
      { id: string; observation_ids: string } | undefined;
  }

  private findPendingMatch(accountId: string, obs: {
    amount_cents: number;
    timestamp: number;
    merchant_text: string;
  }): { id: string; observation_ids: string } | undefined {
    const windowMs = 7 * 24 * 60 * 60 * 1000;
    const startWindow = obs.timestamp - windowMs;

    return this.db.prepare(`
      SELECT id, observation_ids FROM transactions
      WHERE household_id = ?
      AND account_id = ?
      AND amount_cents = ?
      AND timestamp >= ?
      AND state = 'pending'
      ORDER BY ABS(timestamp - ?) ASC
      LIMIT 1
    `).get(hh(), accountId, obs.amount_cents, startWindow, obs.timestamp) as
      { id: string; observation_ids: string } | undefined;
  }

  private createTransaction(
    accountId: string,
    obs: {
      amount_cents: number;
      currency: string;
      fx_amount_cents: number | null;
      fx_currency: string | null;
      timestamp: number;
      merchant_text: string;
      id: string;
      adapter_name: string;
    },
    state: TransactionState
  ): string {
    assertNotLLMSourced({ adapterName: obs.adapter_name }, 'transaction INSERT');
    
    const id = this.generateId();
    const now = Date.now();

    this.db.prepare(`
      INSERT INTO transactions (
        id, household_id, account_id, amount_cents, currency, fx_amount_cents, fx_currency,
        timestamp, merchant_text, state, observation_ids, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      hh(),
      accountId,
      obs.amount_cents,
      obs.currency,
      obs.fx_amount_cents,
      obs.fx_currency,
      obs.timestamp,
      obs.merchant_text,
      state,
      JSON.stringify([obs.id]),
      now,
      now
    );

    return id;
  }

  private updateTransaction(
    id: string,
    updates: {
      state?: TransactionState;
      observationIds?: string[];
      fxAmountCents?: number | null;
      fxCurrency?: string | null;
      adapterName?: string;
    }
  ): void {
    assertNotLLMSourced({ adapterName: updates.adapterName || 'unknown' }, 'transaction state/amount UPDATE');
    
    const parts: string[] = [];
    const params: unknown[] = [];

    if (updates.state) {
      parts.push('state = ?');
      params.push(updates.state);
    }
    if (updates.observationIds) {
      parts.push('observation_ids = ?');
      params.push(JSON.stringify(updates.observationIds));
    }
    if (updates.fxAmountCents !== undefined) {
      parts.push('fx_amount_cents = ?');
      params.push(updates.fxAmountCents);
    }
    if (updates.fxCurrency !== undefined) {
      parts.push('fx_currency = ?');
      params.push(updates.fxCurrency);
    }

    parts.push('updated_at = ?');
    params.push(Date.now());

    params.push(id);

    this.db.prepare(`
      UPDATE transactions SET ${parts.join(', ')} WHERE id = ? AND household_id = ?
    `).run(...params, hh());
  }

  private flagUnpostedHolds(accountId: string, source: 'rule' | 'user' | 'llm' | 'llm-fallback' | 'adapter' = 'rule'): void {
    const cutoffMs = Date.now() - 14 * 24 * 60 * 60 * 1000;

    assertNotLLMSourced({ source }, 'hold flag UPDATE');
    this.db.prepare(`
      UPDATE transactions
      SET notes = 'REVIEW: Hold never posted'
      WHERE household_id = ?
      AND account_id = ?
      AND state = 'pending'
      AND timestamp < ?
      AND notes IS NULL
    `).run(hh(), accountId, cutoffMs);
  }

  private generateId(): string {
    return crypto.randomBytes(8).toString('hex');
  }

  getReviewQueue(accountId?: string): Transaction[] {
    let query = `
      SELECT * FROM transactions
      WHERE household_id = ?
      AND notes LIKE 'REVIEW:%'
    `;
    
    const params: unknown[] = [hh()];
    if (accountId) {
      query += ' AND account_id = ?';
      params.push(accountId);
    }
    
    query += ' ORDER BY timestamp DESC';

    const rows = this.db.prepare(query).all(...params) as Array<{
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

    return rows.map(row => ({
      id: row.id,
      accountId: row.account_id,
      amountCents: row.amount_cents,
      currency: row.currency,
      fxAmountCents: row.fx_amount_cents ?? undefined,
      fxCurrency: row.fx_currency ?? undefined,
      timestamp: row.timestamp,
      merchantText: row.merchant_text,
      state: row.state as TransactionState,
      category: row.category ?? undefined,
      envelopeId: row.envelope_id ?? undefined,
      linkedTransactionId: row.linked_transaction_id ?? undefined,
      observationIds: JSON.parse(row.observation_ids),
      notes: row.notes ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }
}
