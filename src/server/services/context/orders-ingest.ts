import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { contextFlag } from '../../lib/context-flags.js';
import { householdIdForMember } from '../../lib/member-identity.js';
import { hh } from '../../lib/tenancy.js';

export interface IngestOrderItem {
  name: string;
  qty?: number;
  unit_cents?: number | null;
  line_cents?: number | null;
}

export interface IngestOrder {
  merchant: string;
  order_id: string;
  placed_at?: number | string | null;
  currency?: string;
  total_cents?: number | null;
  items?: IngestOrderItem[];
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

export type OrderSource = 'email' | 'extension' | 'wallet' | 'webhook';

export class OrdersIngestService {
  constructor(private db: Database.Database, private now: () => number = () => Date.now()) {}

  ingest(
    memberId: string,
    orders: IngestOrder[],
    source: OrderSource = 'extension',
    options: { sourceHash?: string | null; looseMerchant?: boolean } = {},
  ): { accepted: number; ids: string[] } {
    const skipOrdersFlag = source === 'webhook' || source === 'wallet';
    if (!skipOrdersFlag && !contextFlag('orders')) return { accepted: 0, ids: [] };
    let accepted = 0;
    const ids: string[] = [];
    for (const order of orders) {
      const merchant = normaliseMerchant(order.merchant || '', options.looseMerchant === true);
      const orderRef = String(order.order_id || '').trim();
      if (!merchant || !orderRef) continue;
      const hid = householdIdForMember(this.db, memberId) ?? hh();
      const existing = this.db.prepare(
        'SELECT id FROM orders WHERE household_id = ? AND merchant = ? AND order_ref = ?',
      ).get(hid, merchant, orderRef) as { id: string } | undefined;
      const id = existing?.id ?? crypto.randomBytes(8).toString('hex');
      const placed = parsePlacedAt(order.placed_at) ?? this.now();
      if (!existing) {
        this.db.prepare(`
          INSERT INTO orders (
            id, household_id, merchant, order_ref, member_id, total_cents, currency, ordered_at, source_hash, created_at, source
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        );
      } else {
        this.db.prepare(
          'UPDATE orders SET member_id = COALESCE(member_id, ?), source = ?, source_hash = COALESCE(?, source_hash) WHERE id = ?',
        ).run(memberId || null, source, options.sourceHash ?? null, id);
      }
      this.db.prepare('DELETE FROM order_items WHERE order_id = ?').run(id);
      for (const item of order.items ?? []) {
        if (!item.name) continue;
        this.db.prepare(`
          INSERT INTO order_items (id, household_id, order_id, name, qty, unit_cents, line_cents)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          crypto.randomBytes(8).toString('hex'),
          hid,
          id,
          item.name,
          item.qty ?? 1,
          item.unit_cents ?? null,
          item.line_cents ?? null,
        );
      }
      accepted += 1;
      ids.push(id);
    }
    return { accepted, ids };
  }
}

function parsePlacedAt(raw: number | string | null | undefined): number | null {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw < 1e12 ? raw * 1000 : raw;
  const ms = Date.parse(String(raw));
  return Number.isFinite(ms) ? ms : null;
}
