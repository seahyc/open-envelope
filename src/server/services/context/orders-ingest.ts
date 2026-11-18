import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { contextFlag } from '../../lib/context-flags.js';
import { householdIdForMember } from '../../lib/member-identity.js';
import { hh } from '../../lib/tenancy.js';
import { defaultItemHinter, type ItemCategoryHinter } from './item-hints.js';

export interface IngestOrderItem {
  name: string;
  qty?: number;
  unit_cents?: number | null;
  line_cents?: number | null;
  sku?: string | null;
  url?: string | null;
}

export interface IngestOrder {
  merchant: string;
  order_id: string;
  placed_at?: number | string | null;
  currency?: string;
  total_cents?: number | null;
  items?: IngestOrderItem[];
  status?: string | null;
  buyer_account?: string | null;
  raw?: unknown;
}

export interface OrdersIngestResult {
  accepted: number;
  ids: string[];
  inserted: number;
  updated: number;
}

const MERCHANTS = new Set([
  'lazada',
  'grab',
  'gojek',
  'ryde',
  'shopify',
  'google_play',
  'shopee',
  'amazon_sg',
  'fairprice',
  'taobao',
  'pinduoduo',
]);

export function normaliseMerchant(raw: string, loose = false): string | null {
  const value = raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 48);
  if (MERCHANTS.has(value)) return value;
  if (value.includes('lazada')) return 'lazada';
  if (value.includes('grab')) return 'grab';
  if (value.includes('gojek')) return 'gojek';
  if (value.includes('ryde')) return 'ryde';
  if (value.includes('shopify')) return 'shopify';
  if (value.includes('google_play') || value.includes('googleplay')) return 'google_play';
  if (value.includes('pinduoduo') || value === 'pdd') return 'pinduoduo';
  if (value.includes('taobao') || value.includes('tmall')) return 'taobao';
  if (value.includes('shopee')) return 'shopee';
  if (value.includes('amazon')) return 'amazon_sg';
  if (value.includes('fairprice') || value.includes('fair_price')) return 'fairprice';
  if (loose) return value || null;
  return null;
}

/**
 * 'import' is the signed bulk/sync path (POST /api/ingest/orders with X-OE-Signature).
 * Like webhook/wallet it is explicitly configured, so it is not gated by CONTEXT_ORDERS.
 */
export type OrderSource = 'email' | 'extension' | 'wallet' | 'webhook' | 'import';

export class OrdersIngestService {
  constructor(
    private db: Database.Database,
    private now: () => number = () => Date.now(),
    private hinter: ItemCategoryHinter = defaultItemHinter,
  ) {}

  ingest(
    memberId: string,
    orders: IngestOrder[],
    source: OrderSource = 'extension',
    options: { sourceHash?: string | null; looseMerchant?: boolean; householdId?: string | null } = {},
  ): OrdersIngestResult {
    const skipOrdersFlag = source === 'webhook' || source === 'wallet' || source === 'import';
    if (!skipOrdersFlag && !contextFlag('orders')) return { accepted: 0, ids: [], inserted: 0, updated: 0 };
    let accepted = 0;
    let inserted = 0;
    let updated = 0;
    const ids: string[] = [];
    const authoritative = source === 'import';
    for (const order of orders) {
      const merchant = normaliseMerchant(order.merchant || '', options.looseMerchant === true);
      const orderRef = String(order.order_id || '').trim();
      if (!merchant || !orderRef) continue;
      const hid = options.householdId ?? ((memberId ? householdIdForMember(this.db, memberId) : null) ?? hh());
      const existing = this.db.prepare(
        'SELECT id, total_cents, ordered_at, currency, match_method FROM orders WHERE household_id = ? AND merchant = ? AND order_ref = ?',
      ).get(hid, merchant, orderRef) as
        | { id: string; total_cents: number | null; ordered_at: number | null; currency: string; match_method: string | null }
        | undefined;
      const id = existing?.id ?? crypto.randomBytes(8).toString('hex');
      // Signed imports carry history: never invent "now" for an unknown order date.
      const parsedPlaced = parsePlacedAt(order.placed_at);
      const placed = authoritative ? parsedPlaced : (parsedPlaced ?? this.now());
      const rawJson = order.raw === undefined ? null : JSON.stringify(order.raw);
      if (!existing) {
        this.db.prepare(`
          INSERT INTO orders (
            id, household_id, merchant, order_ref, member_id, total_cents, currency, ordered_at, source_hash, created_at, source,
            status, buyer_account, raw_json, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id,
          hid,
          merchant,
          orderRef,
          memberId || null,
          order.total_cents ?? null,
          order.currency || 'SGD',
          placed,
          options.sourceHash ?? null,
          this.now(),
          source,
          order.status ?? null,
          order.buyer_account ?? null,
          rawJson,
          this.now(),
        );
        inserted += 1;
      } else if (authoritative) {
        const total = order.total_cents ?? null;
        const currency = order.currency || 'SGD';
        const moved = total !== existing.total_cents || placed !== existing.ordered_at || currency !== existing.currency;
        this.db.prepare(`
          UPDATE orders SET
            member_id = COALESCE(member_id, ?), source = ?, total_cents = ?, currency = ?, ordered_at = ?,
            status = ?, buyer_account = COALESCE(?, buyer_account), raw_json = COALESCE(?, raw_json), updated_at = ?
          WHERE id = ?
        `).run(
          memberId || null, source, total, currency, placed,
          order.status ?? null, order.buyer_account ?? null, rawJson, this.now(), id,
        );
        // An amount/date change invalidates an automatic match; the matcher re-runs after ingest.
        if (moved && existing.match_method !== 'manual') {
          this.db.prepare(
            'UPDATE orders SET matched_transaction_id = NULL, match_method = NULL, matched_at = NULL WHERE id = ?',
          ).run(id);
        }
        updated += 1;
      } else {
        this.db.prepare(
          'UPDATE orders SET member_id = COALESCE(member_id, ?), source = ?, source_hash = COALESCE(?, source_hash), updated_at = ? WHERE id = ?',
        ).run(memberId || null, source, options.sourceHash ?? null, this.now(), id);
        updated += 1;
      }
      this.db.prepare('DELETE FROM order_items WHERE order_id = ?').run(id);
      for (const item of order.items ?? []) {
        if (!item.name) continue;
        this.db.prepare(`
          INSERT INTO order_items (
            id, household_id, order_id, name, qty, unit_cents, line_cents, sku, url, suggested_category
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          crypto.randomBytes(8).toString('hex'),
          hid,
          id,
          item.name,
          item.qty ?? 1,
          item.unit_cents ?? null,
          item.line_cents ?? null,
          item.sku ?? null,
          item.url ?? null,
          this.hinter.suggest(item.name),
        );
      }
      accepted += 1;
      ids.push(id);
    }
    return { accepted, ids, inserted, updated };
  }
}

const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;

export function parsePlacedAt(raw: number | string | null | undefined): number | null {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw < 1e12 ? raw * 1000 : raw;
  const text = String(raw).trim();
  // Marketplace order lists give a local calendar date; anchor it at local (SGT) midnight.
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (dateOnly) {
    return Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])) - SGT_OFFSET_MS;
  }
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}
