import type Database from 'better-sqlite3';
import type { Envelope, BudgetAllocation } from '../../shared/types.js';
import crypto from 'crypto';
import { assertNotLLMSourced } from '../lib/llm-guards.js';
import { hh } from '../lib/tenancy.js';

export class BudgetService {
  constructor(private db: Database.Database) {}

  getReadyToAssign(month: string): number {
    const income = this.db.prepare(`
      SELECT COALESCE(SUM(amount_cents), 0) as total
      FROM transactions
      WHERE household_id = ?
      AND strftime('%Y-%m', datetime(timestamp / 1000, 'unixepoch')) = ?
      AND amount_cents > 0
      AND category = 'income'
    `).get(hh(), month) as { total: number };

    const allocated = this.db.prepare(`
      SELECT COALESCE(SUM(allocated_cents), 0) as total
      FROM budget_allocations
      WHERE household_id = ?
      AND month = ?
    `).get(hh(), month) as { total: number };

    return income.total - allocated.total;
  }

  getAllocations(month: string): Array<BudgetAllocation & { envelope: Envelope }> {
    const rows = this.db.prepare(`
      SELECT 
        ba.id,
        ba.envelope_id,
        ba.month,
        ba.allocated_cents,
        ba.created_at,
        e.name as envelope_name,
        e.owner as envelope_owner,
        e.monthly_target_cents as envelope_target,
        e.color as envelope_color,
        e.created_at as envelope_created_at
      FROM budget_allocations ba
      JOIN envelopes e ON ba.envelope_id = e.id
      WHERE ba.household_id = ? AND e.household_id = ?
      AND ba.month = ?
      ORDER BY e.name
    `).all(hh(), hh(), month) as Array<{
      id: string;
      envelope_id: string;
      month: string;
      allocated_cents: number;
      created_at: number;
      envelope_name: string;
      envelope_owner: string;
      envelope_target: number | null;
      envelope_color: string | null;
      envelope_created_at: number;
    }>;

    return rows.map(row => ({
      id: row.id,
      envelopeId: row.envelope_id,
      month: row.month,
      allocatedCents: row.allocated_cents,
      createdAt: row.created_at,
      envelope: {
        id: row.envelope_id,
        name: row.envelope_name,
        owner: row.envelope_owner as 'shared' | 'alex' | 'sam',
        monthlyTargetCents: row.envelope_target ?? undefined,
        color: row.envelope_color ?? undefined,
        createdAt: row.envelope_created_at,
      },
    }));
  }

  allocate(envelopeId: string, month: string, amountCents: number, source: 'user' | 'llm' | 'llm-fallback' | 'rule' | 'adapter' = 'user'): void {
    assertNotLLMSourced({ source }, 'budget allocation INSERT/UPDATE');
    
    const existing = this.db.prepare(`
      SELECT id, allocated_cents FROM budget_allocations
      WHERE household_id = ? AND envelope_id = ? AND month = ?
    `).get(hh(), envelopeId, month) as { id: string; allocated_cents: number } | undefined;

    if (existing) {
      this.db.prepare(`
        UPDATE budget_allocations
        SET allocated_cents = allocated_cents + ?
        WHERE id = ? AND household_id = ?
      `).run(amountCents, existing.id, hh());
    } else {
      this.db.prepare(`
        INSERT INTO budget_allocations (id, household_id, envelope_id, month, allocated_cents, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(crypto.randomBytes(8).toString('hex'), hh(), envelopeId, month, amountCents, Date.now());
    }
  }

  getEnvelopeBalance(envelopeId: string, month: string): {
    allocated: number;
    spent: number;
    available: number;
  } {
    const allocation = this.db.prepare(`
      SELECT COALESCE(SUM(allocated_cents), 0) as total
      FROM budget_allocations
      WHERE household_id = ? AND envelope_id = ? AND month <= ?
    `).get(hh(), envelopeId, month) as { total: number };

    const spent = this.db.prepare(`
      SELECT COALESCE(SUM(ABS(amount_cents)), 0) as total
      FROM transactions
      WHERE household_id = ?
      AND envelope_id = ?
      AND strftime('%Y-%m', datetime(timestamp / 1000, 'unixepoch')) <= ?
      AND amount_cents < 0
    `).get(hh(), envelopeId, month) as { total: number };

    return {
      allocated: allocation.total,
      spent: spent.total,
      available: allocation.total - spent.total,
    };
  }
}
