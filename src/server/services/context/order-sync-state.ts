import type Database from 'better-sqlite3';

/**
 * Health of an always-on order sync (for example a headless-browser sidecar) per shop.
 * The sync reports here after every run so a dead session becomes a visible
 * "re-auth needed" state in the app instead of silently stopping.
 */
export const ORDER_SYNC_STATES = ['ok', 'reauth_needed', 'blocked', 'error'] as const;
export type OrderSyncStateValue = (typeof ORDER_SYNC_STATES)[number];

export interface OrderSyncState {
  shop: string;
  state: OrderSyncStateValue;
  detail: string | null;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  updatedAt: number;
}

export function isOrderSyncState(value: unknown): value is OrderSyncStateValue {
  return typeof value === 'string' && (ORDER_SYNC_STATES as readonly string[]).includes(value);
}

export class OrderSyncStateStore {
  constructor(private db: Database.Database, private now: () => number = () => Date.now()) {}

  report(householdId: string, input: { shop: string; state: OrderSyncStateValue; detail?: string | null }): void {
    const now = this.now();
    const shop = input.shop.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 32);
    if (!shop) throw new Error('shop required');
    this.db.prepare(`
      INSERT INTO order_sync_state (household_id, shop, state, detail, last_attempt_at, last_success_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(household_id, shop) DO UPDATE SET
        state = excluded.state,
        detail = excluded.detail,
        last_attempt_at = excluded.last_attempt_at,
        last_success_at = COALESCE(excluded.last_success_at, order_sync_state.last_success_at),
        updated_at = excluded.updated_at
    `).run(
      householdId,
      shop,
      input.state,
      input.detail ? String(input.detail).slice(0, 300) : null,
      now,
      input.state === 'ok' ? now : null,
      now,
    );
  }

  list(householdId: string): OrderSyncState[] {
    const rows = this.db.prepare(`
      SELECT shop, state, detail, last_attempt_at, last_success_at, updated_at
      FROM order_sync_state WHERE household_id = ? ORDER BY shop
    `).all(householdId) as Array<{
      shop: string;
      state: OrderSyncStateValue;
      detail: string | null;
      last_attempt_at: number | null;
      last_success_at: number | null;
      updated_at: number;
    }>;
    return rows.map((row) => ({
      shop: row.shop,
      state: row.state,
      detail: row.detail,
      lastAttemptAt: row.last_attempt_at,
      lastSuccessAt: row.last_success_at,
      updatedAt: row.updated_at,
    }));
  }
}
