import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { contextFlag } from '../../lib/context-flags.js';
import { normalizeMerchantKey } from '../../categoriser/normalize.js';
import { hh } from '../../lib/tenancy.js';

const DAY = 24 * 60 * 60 * 1000;
const HALF_HOUR = 30 * 60 * 1000;

export interface ContextSnippet {
  id: string;
  kind: 'order' | 'place' | 'calendar' | 'note';
  snippet: string;
  sourceId: string;
  proposedSplit: Array<{ name: string; qty: number; lineCents: number | null }> | null;
  memberName: string | null;
}

export class TriangulateService {
  constructor(private db: Database.Database, private now: () => number = () => Date.now()) {}

  snippetsFor(transactionId: string): ContextSnippet[] {
    const rows = this.db.prepare(`
      SELECT id, kind, snippet, source_id, proposed_split, status
      FROM context_links
      WHERE transaction_id = ? AND status != 'rejected'
      ORDER BY kind
    `).all(transactionId) as Array<{
      id: string;
      kind: string;
      snippet: string;
      source_id: string;
      proposed_split: string | null;
      status: string;
    }>;
    const attr = this.db.prepare(`
      SELECT hm.name
      FROM spent_attributions sa
      JOIN household_members hm ON hm.id = sa.member_id
      WHERE sa.transaction_id = ? AND sa.status != 'rejected'
    `).get(transactionId) as { name: string } | undefined;
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind as ContextSnippet['kind'],
      snippet: row.snippet,
      sourceId: row.source_id,
      proposedSplit: parseSplit(row.proposed_split),
      memberName: attr?.name ?? null,
    }));
  }

  evidenceLine(transactionId: string): string | null {
    const snippets = this.snippetsFor(transactionId);
    if (snippets.length === 0) return null;
    const parts = snippets.map((item) => {
      if (item.kind === 'order') {
        const names = (item.proposedSplit ?? []).map((row) => row.name).filter(Boolean);
        return names.length ? names.join(', ') : item.snippet;
      }
      if (item.kind === 'place') {
        return item.snippet.replace(/\s+\d.*/, '');
      }
      return item.snippet.replace(/^calendar:\s*/i, '');
    });
    return parts.join('; ');
  }

  forTransactions(transactionIds: string[]): number {
    if (!contextFlag('triangulate')) return 0;
    let links = 0;
    for (const id of transactionIds) links += this.forTransaction(id);
    return links;
  }

  forRecentTransactions(windowMs = 7 * DAY): number {
    if (!contextFlag('triangulate')) return 0;
    const now = this.now();
    const ids = (this.db.prepare(
      'SELECT id FROM transactions WHERE timestamp BETWEEN ? AND ?'
    ).all(now - windowMs, now + 2 * DAY) as Array<{ id: string }>).map((row) => row.id);
    return this.forTransactions(ids);
  }

  forTransaction(transactionId: string): number {
    if (!contextFlag('triangulate')) return 0;
    const tx = this.db.prepare(
      'SELECT id, merchant_text, amount_cents, timestamp FROM transactions WHERE id = ?'
    ).get(transactionId) as
      | { id: string; merchant_text: string; amount_cents: number; timestamp: number }
      | undefined;
    if (!tx) return 0;
    let created = 0;
    created += this.matchOrders(tx);
    created += this.matchPlaces(tx);
    created += this.matchCalendar(tx);
    return created;
  }

  confirm(linkId: string, options: { split?: boolean } = {}): void {
    const link = this.db.prepare(
      'SELECT id, transaction_id, kind, source_id, proposed_split FROM context_links WHERE id = ?'
    ).get(linkId) as
      | { id: string; transaction_id: string; kind: string; source_id: string; proposed_split: string | null }
      | undefined;
    if (!link) throw new Error('Link not found');
    this.db.prepare(
      "UPDATE context_links SET status = 'confirmed' WHERE id = ?"
    ).run(linkId);
    if (options.split && link.proposed_split) {
      const items = parseSplit(link.proposed_split) ?? [];
      const note = items.map((item) => `${item.qty}× ${item.name}`).join(', ');
      if (note) {
        this.db.prepare(
          "UPDATE transactions SET notes = TRIM(COALESCE(notes, '') || char(10) || ?), updated_at = ? WHERE id = ?"
        ).run(note, this.now(), link.transaction_id);
      }
    }
    if (link.kind === 'order') {
      const order = this.db.prepare('SELECT member_id FROM orders WHERE id = ?').get(link.source_id) as
        | { member_id: string | null }
        | undefined;
      if (order?.member_id) {
        this.db.prepare(`
          INSERT INTO spent_attributions (household_id, transaction_id, member_id, source, status)
          VALUES (?, ?, ?, 'order', 'confirmed')
          ON CONFLICT(transaction_id) DO UPDATE SET
            member_id = excluded.member_id, source = excluded.source, status = excluded.status
        `).run(hh(), link.transaction_id, order.member_id);
      }
    }
  }

  reject(linkId: string): void {
    this.db.prepare("UPDATE context_links SET status = 'rejected' WHERE id = ?").run(linkId);
  }

  private matchOrders(tx: { id: string; merchant_text: string; amount_cents: number; timestamp: number }): number {
    const amount = Math.abs(tx.amount_cents);
    const orders = this.db.prepare(`
      SELECT id, merchant, order_ref, member_id, total_cents, ordered_at
      FROM orders
      WHERE ordered_at BETWEEN ? AND ?
    `).all(tx.timestamp - 2 * DAY, tx.timestamp + 2 * DAY) as Array<{
      id: string;
      merchant: string;
      order_ref: string;
      member_id: string | null;
      total_cents: number | null;
      ordered_at: number | null;
    }>;
    const merchantKey = normalizeMerchantKey(tx.merchant_text);
    let created = 0;
    const matching = orders.filter((order) => {
      if (!merchantOverlap(merchantKey, order.merchant)) return false;
      if (order.total_cents == null) return false;
      return amountsClose(amount, Math.abs(order.total_cents));
    });
    if (matching.length === 0) {
      const sameMerchant = orders.filter((order) => merchantOverlap(merchantKey, order.merchant) && order.total_cents != null);
      const sum = sameMerchant.reduce((acc, order) => acc + Math.abs(order.total_cents ?? 0), 0);
      if (sameMerchant.length > 1 && amountsClose(amount, sum)) {
        for (const order of sameMerchant) created += this.linkOrder(tx.id, order);
      }
      return created;
    }
    for (const order of matching) created += this.linkOrder(tx.id, order);
    return created;
  }

  private linkOrder(
    transactionId: string,
    order: { id: string; merchant: string; order_ref: string; member_id: string | null }
  ): number {
    const items = this.db.prepare(
      'SELECT name, qty, line_cents FROM order_items WHERE order_id = ?'
    ).all(order.id) as Array<{ name: string; qty: number; line_cents: number | null }>;
    const label = displayMerchant(order.merchant);
    const snippet = `${label} order #${order.order_ref}: ${items.length || 1} item${items.length === 1 ? '' : 's'}`;
    const split = items.length > 1 ? JSON.stringify(items.map((item) => ({
      name: item.name,
      qty: item.qty,
      lineCents: item.line_cents,
    }))) : null;
    const inserted = this.upsertLink(transactionId, 'order', order.id, 0.8, snippet, split);
    if (order.member_id) {
      this.db.prepare(`
        INSERT INTO spent_attributions (household_id, transaction_id, member_id, source, status)
        VALUES (?, ?, ?, 'order', 'proposed')
        ON CONFLICT(transaction_id) DO UPDATE SET
          member_id = excluded.member_id, source = excluded.source
      `).run(hh(), transactionId, order.member_id);
    }
    return inserted;
  }

  private matchPlaces(tx: { id: string; merchant_text: string; timestamp: number }): number {
    const visits = this.db.prepare(`
      SELECT id, place_name, arrived_at, left_at
      FROM place_visits
      WHERE arrived_at - ? <= ? AND left_at + ? >= ?
    `).all(HALF_HOUR, tx.timestamp, HALF_HOUR, tx.timestamp) as Array<{
      id: string;
      place_name: string | null;
      arrived_at: number;
      left_at: number;
    }>;
    const merchantKey = normalizeMerchantKey(tx.merchant_text);
    let created = 0;
    for (const visit of visits) {
      const name = visit.place_name || '';
      if (name && !tokenOverlap(merchantKey, name) && !tokenOverlap(tx.merchant_text, name)) continue;
      if (!name && !tokenOverlap(merchantKey, 'place')) continue;
      const snippet = `at ${name || 'unknown place'} ${formatClockRange(visit.arrived_at, visit.left_at)}`;
      created += this.upsertLink(tx.id, 'place', visit.id, 0.7, snippet, null);
    }
    return created;
  }

  private matchCalendar(tx: { id: string; merchant_text: string; timestamp: number }): number {
    const events = this.db.prepare(`
      SELECT id, title, location, starts_at, ends_at
      FROM calendar_events
      WHERE starts_at - ? <= ? AND ends_at + ? >= ?
    `).all(HALF_HOUR, tx.timestamp, HALF_HOUR, tx.timestamp) as Array<{
      id: string;
      title: string;
      location: string | null;
      starts_at: number;
      ends_at: number;
    }>;
    const merchantKey = normalizeMerchantKey(tx.merchant_text);
    let created = 0;
    for (const event of events) {
      const hay = `${event.title} ${event.location || ''}`;
      if (!tokenOverlap(merchantKey, hay) && !tokenOverlap(tx.merchant_text, hay)) continue;
      created += this.upsertLink(tx.id, 'calendar', event.id, 0.65, `calendar: ${event.title}`, null);
    }
    return created;
  }

  private upsertLink(
    transactionId: string,
    kind: string,
    sourceId: string,
    confidence: number,
    snippet: string,
    proposedSplit: string | null
  ): number {
    const existing = this.db.prepare(
      'SELECT id FROM context_links WHERE transaction_id = ? AND kind = ? AND source_id = ?'
    ).get(transactionId, kind, sourceId) as { id: string } | undefined;
    if (existing) {
      this.db.prepare(
        'UPDATE context_links SET snippet = ?, proposed_split = ?, confidence = ? WHERE id = ? AND status = ?'
      ).run(snippet, proposedSplit, confidence, existing.id, 'proposed');
      return 0;
    }
    this.db.prepare(`
      INSERT INTO context_links (
        id, household_id, transaction_id, kind, source_id, confidence, snippet, proposed_split, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?)
    `).run(
      crypto.randomBytes(8).toString('hex'),
      hh(),
      transactionId,
      kind,
      sourceId,
      confidence,
      snippet,
      proposedSplit,
      this.now()
    );
    return 1;
  }
}

function parseSplit(raw: string | null): ContextSnippet['proposedSplit'] {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.map((row) => ({
      name: String((row as { name?: string }).name ?? ''),
      qty: Number((row as { qty?: number }).qty ?? 1),
      lineCents: typeof (row as { lineCents?: number }).lineCents === 'number'
        ? (row as { lineCents: number }).lineCents
        : null,
    }));
  } catch {
    return null;
  }
}

function amountsClose(cardCents: number, orderCents: number): boolean {
  if (cardCents === orderCents) return true;
  const slack = Math.max(50, Math.round(cardCents * 0.02));
  return Math.abs(cardCents - orderCents) <= slack;
}

function merchantOverlap(txKey: string, orderMerchant: string): boolean {
  const tokens = displayMerchant(orderMerchant).toUpperCase().split(/\s+/);
  return tokens.some((token) => token.length >= 4 && txKey.includes(token));
}

function displayMerchant(merchant: string): string {
  if (merchant === 'amazon_sg') return 'Amazon';
  if (merchant === 'fairprice') return 'FairPrice';
  if (merchant === 'google_play') return 'Google Play';
  if (merchant === 'grab') return 'Grab';
  if (merchant === 'gojek') return 'Gojek';
  if (merchant === 'ryde') return 'Ryde';
  if (merchant === 'shopify') return 'Shopify';
  if (merchant === 'taobao') return 'Taobao';
  if (merchant === 'pinduoduo') return 'Pinduoduo';
  return merchant.charAt(0).toUpperCase() + merchant.slice(1);
}

function tokenOverlap(a: string, b: string): boolean {
  const left = tokenize(a);
  const right = tokenize(b);
  for (const token of left) {
    if (token.length < 4) continue;
    if (right.has(token)) return true;
  }
  return false;
}

function tokenize(value: string): Set<string> {
  return new Set(value.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').split(' ').filter(Boolean));
}

export function formatClockRange(start: number, end: number): string {
  const a = clock(start);
  const b = clock(end);
  if (a.period === b.period) return `${a.core}–${b.core}${b.period}`;
  return `${a.core}${a.period}–${b.core}${b.period}`;
}

function clock(ts: number): { core: string; period: string } {
  const d = new Date(ts);
  let hours = d.getUTCHours();
  const minutes = d.getUTCMinutes();
  const period = hours >= 12 ? 'pm' : 'am';
  hours = hours % 12;
  if (hours === 0) hours = 12;
  const min = minutes.toString().padStart(2, '0');
  return { core: `${hours}:${min}`, period };
}
