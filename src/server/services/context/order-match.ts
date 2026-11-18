import type Database from 'better-sqlite3';
import { hh } from '../../lib/tenancy.js';

/**
 * Deterministic order -> card/bank charge matching for marketplace orders.
 *
 * Rules (conservative; never forces a match):
 *  - the transaction is an outflow on a budget (bank) or credit (card) account,
 *    in the order's currency, and its merchant text names the shop;
 *  - the transaction falls between 2 days before and 10 days after the order date;
 *  - one-to-one: amount equals -total exactly, and the pairing is unique both ways
 *    (the order has one candidate charge and that charge has one candidate order);
 *  - many-to-one: when a charge has no single-order match, 2-4 unmatched orders from
 *    the same shop placed within a day of each other sum exactly to it, and that
 *    combination is the only one that does.
 *
 * Writes only orders.matched_transaction_id / match_method / matched_at. It never
 * touches transaction amounts, states or categories. Manual matches are left alone.
 */

const DAY = 24 * 60 * 60 * 1000;
export const MATCH_WINDOW_BEFORE_MS = 2 * DAY;
export const MATCH_WINDOW_AFTER_MS = 10 * DAY;
const GROUP_SPREAD_MS = DAY;
const GROUP_MAX_SIZE = 4;
const GROUP_MAX_CANDIDATES = 14;

export type Shop = 'amazon' | 'lazada' | 'shopee';

/** orders.merchant values handled by the deterministic matcher. */
const SHOP_FOR_ORDER_MERCHANT: Record<string, Shop> = {
  amazon_sg: 'amazon',
  amazon: 'amazon',
  lazada: 'lazada',
  shopee: 'shopee',
};

export function shopForOrderMerchant(merchant: string): Shop | null {
  return SHOP_FOR_ORDER_MERCHANT[merchant] ?? null;
}

// "AMAZE*" is a card-wrapper prefix, not Amazon; AMZNPRIMESG-style membership fees are not orders.
const SHOP_PATTERNS: Array<{ shop: Shop; pattern: RegExp }> = [
  { shop: 'amazon', pattern: /\bAMAZON\b|\bAMZN\b|\bAMZN\s*MKTP|AMAZON\s*(MKTPLC|MARKETPLACE|SG|\.SG)/i },
  { shop: 'lazada', pattern: /LAZADA/i },
  { shop: 'shopee', pattern: /SHOPEE|SEA\s+LIMITED/i },
];
const SHOP_EXCLUDE = /AMZNPRIME|AMAZON\s*PRIME|PRIME\s*MEMBERSH/i;

/** Which marketplace a card/bank merchant string refers to, if any. */
export function shopForMerchantText(text: string | null | undefined): Shop | null {
  const value = text || '';
  if (!value || SHOP_EXCLUDE.test(value)) return null;
  for (const row of SHOP_PATTERNS) {
    if (row.pattern.test(value)) return row.shop;
  }
  return null;
}

interface OrderRow {
  id: string;
  merchant: string;
  total_cents: number;
  currency: string;
  ordered_at: number;
}

interface TxRow {
  id: string;
  amount_cents: number;
  currency: string;
  timestamp: number;
  merchant_text: string;
}

export interface MatchSummary {
  exact: number;
  grouped: number;
  ambiguous: number;
  unmatched: number;
}

export interface OrderItemView {
  orderId: string;
  shop: string;
  orderRef: string;
  title: string;
  qty: number;
  unitCents: number | null;
  lineCents: number | null;
  url: string | null;
  suggestedCategory: string | null;
}

export interface OrdersStatus {
  total: number;
  matched: number;
  unmatched: number;
  /** Unmatched orders placed late enough that their charge could be in the ledger (excludes pre-history). */
  unmatchedInRange: number;
  byShop: Record<string, { total: number; matched: number; unmatched: number }>;
}

export class OrderMatchService {
  constructor(private db: Database.Database, private now: () => number = () => Date.now()) {}

  /** Re-run matching for every unmatched order in the current household. Idempotent. */
  matchHousehold(householdId: string = hh()): MatchSummary {
    const run = this.db.transaction(() => this.matchHouseholdTx(householdId));
    return run();
  }

  private matchHouseholdTx(householdId: string): MatchSummary {
    // Auto matches whose transaction disappeared become unmatched again.
    this.db.prepare(`
      UPDATE orders SET matched_transaction_id = NULL, match_method = NULL, matched_at = NULL
      WHERE household_id = ? AND matched_transaction_id IS NOT NULL AND IFNULL(match_method, '') != 'manual'
        AND matched_transaction_id NOT IN (SELECT id FROM transactions WHERE household_id = ?)
    `).run(householdId, householdId);

    const orders = (this.db.prepare(`
      SELECT id, merchant, total_cents, currency, ordered_at
      FROM orders
      WHERE household_id = ? AND matched_transaction_id IS NULL
        AND total_cents IS NOT NULL AND total_cents > 0 AND ordered_at IS NOT NULL
      ORDER BY ordered_at ASC
    `).all(householdId) as OrderRow[]).filter((order) => shopForOrderMerchant(order.merchant));
    if (orders.length === 0) return { exact: 0, grouped: 0, ambiguous: 0, unmatched: 0 };

    const minAt = Math.min(...orders.map((order) => order.ordered_at)) - MATCH_WINDOW_BEFORE_MS;
    const maxAt = Math.max(...orders.map((order) => order.ordered_at)) + MATCH_WINDOW_AFTER_MS;
    const taken = new Set((this.db.prepare(
      'SELECT DISTINCT matched_transaction_id AS id FROM orders WHERE household_id = ? AND matched_transaction_id IS NOT NULL',
    ).all(householdId) as Array<{ id: string }>).map((row) => row.id));
    const txs = (this.db.prepare(`
      SELECT t.id, t.amount_cents, t.currency, t.timestamp, t.merchant_text
      FROM transactions t
      JOIN accounts a ON a.id = t.account_id
      WHERE t.household_id = ? AND a.account_group IN ('budget', 'credit')
        AND t.amount_cents < 0 AND t.timestamp BETWEEN ? AND ?
        AND t.linked_transaction_id IS NULL
    `).all(householdId, minAt, maxAt) as TxRow[])
      .filter((tx) => !taken.has(tx.id))
      .map((tx) => ({ ...tx, shop: shopForMerchantText(tx.merchant_text) }))
      .filter((tx): tx is TxRow & { shop: Shop } => tx.shop !== null);

    const inWindow = (order: OrderRow, tx: TxRow) =>
      tx.timestamp >= order.ordered_at - MATCH_WINDOW_BEFORE_MS
      && tx.timestamp <= order.ordered_at + MATCH_WINDOW_AFTER_MS;
    const compatible = (order: OrderRow, tx: TxRow & { shop: Shop }) =>
      shopForOrderMerchant(order.merchant) === tx.shop
      && order.currency === tx.currency
      && inWindow(order, tx);

    const link = this.db.prepare(`
      UPDATE orders SET matched_transaction_id = ?, match_method = ?, matched_at = ?
      WHERE id = ? AND household_id = ? AND matched_transaction_id IS NULL
    `);
    const matchedOrders = new Set<string>();
    const usedTx = new Set<string>();
    let exact = 0;
    let grouped = 0;

    // Pass 1: exact amount, mutually unique (the order has one candidate charge and that
    // charge has one candidate order). Anything else is ambiguous and left for the user.
    const orderCands = new Map<string, string[]>();
    const txCands = new Map<string, string[]>();
    for (const order of orders) {
      for (const tx of txs) {
        if (-tx.amount_cents !== order.total_cents || !compatible(order, tx)) continue;
        orderCands.set(order.id, [...(orderCands.get(order.id) ?? []), tx.id]);
        txCands.set(tx.id, [...(txCands.get(tx.id) ?? []), order.id]);
      }
    }
    for (const [orderId, cands] of orderCands) {
      if (cands.length !== 1) continue;
      const txId = cands[0]!;
      if ((txCands.get(txId) ?? []).length !== 1) continue;
      link.run(txId, 'exact', this.now(), orderId, householdId);
      matchedOrders.add(orderId);
      usedTx.add(txId);
      exact += 1;
    }

    // Orders that still have an exact-amount candidate are ambiguous, not group material.
    const ambiguousOrders = new Set<string>();
    for (const order of orders) {
      if (matchedOrders.has(order.id)) continue;
      if (txs.some((tx) => !usedTx.has(tx.id) && -tx.amount_cents === order.total_cents && compatible(order, tx))) {
        ambiguousOrders.add(order.id);
      }
    }

    // Pass 2: many-to-one. Each charge proposes its unique subset; conflicting proposals are dropped.
    const proposals = new Map<string, string[]>();
    for (const tx of txs) {
      if (usedTx.has(tx.id)) continue;
      const pool = orders.filter((order) =>
        !matchedOrders.has(order.id) && !ambiguousOrders.has(order.id)
        && order.total_cents < -tx.amount_cents && compatible(order, tx));
      if (pool.length < 2 || pool.length > GROUP_MAX_CANDIDATES) continue;
      const solutions = subsetsSummingTo(pool, -tx.amount_cents);
      if (solutions.length === 1) proposals.set(tx.id, solutions[0]!.map((order) => order.id));
    }
    const claims = new Map<string, number>();
    for (const ids of proposals.values()) for (const id of ids) claims.set(id, (claims.get(id) ?? 0) + 1);
    for (const [txId, ids] of proposals) {
      if (ids.some((id) => (claims.get(id) ?? 0) > 1)) continue;
      for (const id of ids) {
        link.run(txId, 'group', this.now(), id, householdId);
        matchedOrders.add(id);
      }
      usedTx.add(txId);
      grouped += ids.length;
    }

    const unmatched = orders.filter((order) => !matchedOrders.has(order.id)).length;
    return { exact, grouped, ambiguous: [...ambiguousOrders].filter((id) => !matchedOrders.has(id)).length, unmatched };
  }

  /** Item lines of orders matched to the given transactions, keyed by transaction id. */
  itemsForTransactions(transactionIds: string[], householdId: string = hh()): Map<string, OrderItemView[]> {
    const out = new Map<string, OrderItemView[]>();
    if (transactionIds.length === 0) return out;
    const chunk = 400;
    for (let i = 0; i < transactionIds.length; i += chunk) {
      const ids = transactionIds.slice(i, i + chunk);
      const rows = this.db.prepare(`
        SELECT o.matched_transaction_id AS tx_id, o.id AS order_id, o.merchant, o.order_ref,
               it.name, it.qty, it.unit_cents, it.line_cents, it.url, it.suggested_category
        FROM orders o
        JOIN order_items it ON it.order_id = o.id
        WHERE o.household_id = ? AND o.matched_transaction_id IN (${ids.map(() => '?').join(', ')})
        ORDER BY o.ordered_at, o.order_ref, it.rowid
      `).all(householdId, ...ids) as Array<{
        tx_id: string;
        order_id: string;
        merchant: string;
        order_ref: string;
        name: string;
        qty: number;
        unit_cents: number | null;
        line_cents: number | null;
        url: string | null;
        suggested_category: string | null;
      }>;
      for (const row of rows) {
        const list = out.get(row.tx_id) ?? [];
        list.push({
          orderId: row.order_id,
          shop: shopForOrderMerchant(row.merchant) ?? row.merchant,
          orderRef: row.order_ref,
          title: row.name,
          qty: row.qty,
          unitCents: row.unit_cents,
          lineCents: row.line_cents ?? (row.unit_cents != null ? Math.round(row.unit_cents * row.qty) : null),
          url: row.url,
          suggestedCategory: row.suggested_category,
        });
        out.set(row.tx_id, list);
      }
    }
    return out;
  }

  /**
   * Categoriser context: what was actually bought. Advisory only — the categoriser
   * runs only on uncategorised transactions and never overrides a user's category.
   */
  evidenceLine(transactionId: string, householdId: string = hh()): string | null {
    const items = this.itemsForTransactions([transactionId], householdId).get(transactionId) ?? [];
    if (items.length === 0) return null;
    const titles = items.slice(0, 8).map((item) => {
      const hint = item.suggestedCategory ? ` [hint: ${item.suggestedCategory}]` : '';
      return `${item.qty > 1 ? `${item.qty}x ` : ''}${item.title.slice(0, 80)}${hint}`;
    });
    const more = items.length > 8 ? `; +${items.length - 8} more` : '';
    return `order items: ${titles.join('; ')}${more}`;
  }

  status(householdId: string = hh()): OrdersStatus {
    const rows = this.db.prepare(`
      SELECT merchant, COUNT(*) AS total, SUM(matched_transaction_id IS NOT NULL) AS matched
      FROM orders WHERE household_id = ? GROUP BY merchant
    `).all(householdId) as Array<{ merchant: string; total: number; matched: number | null }>;
    const byShop: OrdersStatus['byShop'] = {};
    let total = 0;
    let matched = 0;
    for (const row of rows) {
      const shop = shopForOrderMerchant(row.merchant) ?? row.merchant;
      const m = row.matched ?? 0;
      const prev = byShop[shop] ?? { total: 0, matched: 0, unmatched: 0 };
      byShop[shop] = { total: prev.total + row.total, matched: prev.matched + m, unmatched: prev.unmatched + row.total - m };
      total += row.total;
      matched += m;
    }
    const first = this.db.prepare(`
      SELECT MIN(t.timestamp) AS at FROM transactions t JOIN accounts a ON a.id = t.account_id
      WHERE t.household_id = ? AND a.account_group IN ('budget', 'credit')
    `).get(householdId) as { at: number | null };
    const inRange = first.at == null ? { n: 0 } : this.db.prepare(`
      SELECT COUNT(*) AS n FROM orders
      WHERE household_id = ? AND matched_transaction_id IS NULL
        AND (ordered_at IS NULL OR ordered_at >= ?)
    `).get(householdId, first.at - MATCH_WINDOW_AFTER_MS) as { n: number };
    return { total, matched, unmatched: total - matched, unmatchedInRange: inRange.n, byShop };
  }

  /** Matched state of specific orders (for ingest responses). */
  matchedCount(orderIds: string[]): number {
    if (orderIds.length === 0) return 0;
    let n = 0;
    const chunk = 400;
    for (let i = 0; i < orderIds.length; i += chunk) {
      const ids = orderIds.slice(i, i + chunk);
      const row = this.db.prepare(
        `SELECT COUNT(*) AS n FROM orders WHERE matched_transaction_id IS NOT NULL AND id IN (${ids.map(() => '?').join(', ')})`,
      ).get(...ids) as { n: number };
      n += row.n;
    }
    return n;
  }
}

function subsetsSummingTo(pool: OrderRow[], target: number): OrderRow[][] {
  const sorted = [...pool].sort((a, b) => a.ordered_at - b.ordered_at);
  const found: OrderRow[][] = [];
  const pick: OrderRow[] = [];
  const walk = (start: number, sum: number) => {
    if (found.length > 1) return;
    if (pick.length >= 2 && sum === target) {
      const spread = pick[pick.length - 1]!.ordered_at - pick[0]!.ordered_at;
      if (spread <= GROUP_SPREAD_MS) found.push([...pick]);
      return;
    }
    if (pick.length >= GROUP_MAX_SIZE || sum >= target) return;
    for (let i = start; i < sorted.length; i += 1) {
      const next = sorted[i]!;
      if (pick.length > 0 && next.ordered_at - pick[0]!.ordered_at > GROUP_SPREAD_MS) break;
      pick.push(next);
      walk(i + 1, sum + next.total_cents);
      pick.pop();
    }
  };
  walk(0, 0);
  return found;
}
