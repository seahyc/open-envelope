import type Database from 'better-sqlite3';
import { DEFAULT_HOUSEHOLD_ID, hh, TENANT_TABLES } from '../lib/tenancy.js';

export interface HouseholdRow {
  id: string;
  name: string;
  currency: string;
  budgetStartDate: string | null;
  onboardingStep: string;
  onboardingPayload: unknown;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export class HouseholdService {
  constructor(private db: Database.Database) {}

  get(id: string = hh()): HouseholdRow | null {
    const row = this.db.prepare(
      `SELECT id, name, currency, budget_start_date, onboarding_step, onboarding_payload,
              created_at, updated_at, deleted_at
       FROM households WHERE id = ? AND deleted_at IS NULL`
    ).get(id) as {
      id: string;
      name: string;
      currency: string;
      budget_start_date: string | null;
      onboarding_step: string;
      onboarding_payload: string | null;
      created_at: number;
      updated_at: number;
      deleted_at: number | null;
    } | undefined;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      currency: row.currency,
      budgetStartDate: row.budget_start_date,
      onboardingStep: row.onboarding_step,
      onboardingPayload: row.onboarding_payload ? JSON.parse(row.onboarding_payload) : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
    };
  }

  current(): HouseholdRow | null {
    return this.get(hh());
  }

  ensureDefault(): HouseholdRow {
    const existing = this.get(DEFAULT_HOUSEHOLD_ID);
    if (existing) return existing;
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO households (id, name, currency, onboarding_step, created_at, updated_at)
      VALUES (?, 'Household', 'SGD', 'welcome', ?, ?)
    `).run(DEFAULT_HOUSEHOLD_ID, now, now);
    return this.get(DEFAULT_HOUSEHOLD_ID)!;
  }

  exportSnapshot(): { householdId: string; exportedAt: number; tables: Record<string, unknown[]> } {
    const id = hh();
    const tables: Record<string, unknown[]> = {};
    const household = this.db.prepare('SELECT * FROM households WHERE id = ?').all(id);
    tables.households = household as unknown[];
    tables.household_invites = this.db.prepare('SELECT * FROM household_invites WHERE household_id = ?').all(id) as unknown[];
    for (const table of TENANT_TABLES) {
      const exists = this.db.prepare(
        "SELECT 1 as ok FROM sqlite_master WHERE type = 'table' AND name = ?"
      ).get(table) as { ok: number } | undefined;
      if (!exists) continue;
      const cols = (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
      if (!cols.includes('household_id')) continue;
      tables[table] = this.db.prepare(`SELECT * FROM ${table} WHERE household_id = ?`).all(id) as unknown[];
    }
    return { householdId: id, exportedAt: Date.now(), tables };
  }

  /**
   * Dev/e2e: wipe tenant #1 data (including Connections/webhook rows that FK
   * members) and put the household back on the first-run wizard. Keeps `hh-1`.
   */
  resetOnboarding(): void {
    const id = hh();
    this.db.pragma('foreign_keys = OFF');
    try {
      this.wipeTenantRows(id);
      this.db.prepare(`
        UPDATE households
        SET name = 'Household', currency = 'SGD', budget_start_date = NULL,
            onboarding_step = 'welcome', onboarding_payload = NULL, updated_at = ?
        WHERE id = ?
      `).run(Date.now(), id);
    } finally {
      this.db.pragma('foreign_keys = ON');
    }
  }

  deleteCurrent(confirmName: string, mode: 'hosted' | 'selfhost' | 'none' = 'selfhost'): void {
    const row = this.current();
    if (!row) throw new Error('No household');
    if (row.name.trim() !== confirmName.trim()) {
      throw new Error('Type the household name to delete.');
    }
    const id = row.id;
    const now = Date.now();
    if (mode === 'hosted') {
      this.db.prepare('UPDATE households SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
      return;
    }
    this.db.pragma('foreign_keys = OFF');
    try {
      this.wipeTenantRows(id);
      this.db.prepare('DELETE FROM sessions WHERE household_id = ?').run(id);
      this.db.prepare('DELETE FROM households WHERE id = ?').run(id);
    } finally {
      this.db.pragma('foreign_keys = ON');
    }
    if (id === DEFAULT_HOUSEHOLD_ID) this.ensureDefault();
  }

  private wipeTenantRows(id: string): void {
    for (const table of [...TENANT_TABLES].reverse()) {
      const exists = this.db.prepare(
        "SELECT 1 as ok FROM sqlite_master WHERE type = 'table' AND name = ?"
      ).get(table) as { ok: number } | undefined;
      if (!exists) continue;
      const cols = (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
      if (!cols.includes('household_id')) continue;
      this.db.prepare(`DELETE FROM ${table} WHERE household_id = ?`).run(id);
    }
    this.db.prepare('DELETE FROM household_invites WHERE household_id = ?').run(id);
  }
}
