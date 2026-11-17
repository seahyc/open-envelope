import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { contextFlag } from '../../lib/context-flags.js';
import { householdIdForMember } from '../../lib/member-identity.js';
import { hh } from '../../lib/tenancy.js';
import {
  OrdersIngestService,
  type IngestOrder,
  type IngestOrderItem,
} from './orders-ingest.js';

export type IngestEventSource = 'email' | 'extension' | 'wallet' | 'webhook' | 'owntracks';

export type TypedEventType = 'order' | 'txn_alert' | 'place_visit' | 'calendar_event' | 'note';

export interface OrderItemEvent {
  name: string;
  qty?: number;
  unit_price?: number;
  unit_cents?: number;
  line_cents?: number;
}

export interface OrderEvent {
  type: 'order';
  version: 1;
  event_id?: string;
  merchant: string;
  order_id: string;
  placed_at?: number | string | null;
  currency?: string;
  total?: number;
  total_cents?: number;
  items?: OrderItemEvent[];
  source_hash?: string | null;
}

export interface TxnAlertEvent {
  type: 'txn_alert';
  version: 1;
  event_id?: string;
  account_hint?: string;
  merchant: string;
  amount?: number;
  amount_cents?: number;
  currency?: string;
  at?: number | string | null;
}

export interface PlaceVisitEvent {
  type: 'place_visit';
  version: 1;
  event_id?: string;
  place_name: string;
  lat?: number;
  lng?: number;
  arrived_at: number | string;
  left_at?: number | string | null;
}

export interface CalendarEventEvent {
  type: 'calendar_event';
  version: 1;
  event_id?: string;
  title: string;
  location?: string;
  starts_at: number | string;
  ends_at?: number | string | null;
}

export interface NoteEvent {
  type: 'note';
  version: 1;
  event_id?: string;
  text: string;
  match?: {
    merchant?: string;
    amount?: number;
    amount_cents?: number;
    at?: number | string | null;
    account_hint?: string;
  };
}

export type TypedEvent = OrderEvent | TxnAlertEvent | PlaceVisitEvent | CalendarEventEvent | NoteEvent;

export interface DispatchResult {
  accepted: number;
  ids: string[];
}

const TYPED = new Set<TypedEventType>(['order', 'txn_alert', 'place_visit', 'calendar_event', 'note']);

export function isTypedEvent(value: unknown): value is TypedEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && TYPED.has(type as TypedEventType);
}

export function extractTypedEvents(payload: unknown): TypedEvent[] {
  if (Array.isArray(payload)) return payload.filter(isTypedEvent);
  if (payload && typeof payload === 'object') {
    const events = (payload as { events?: unknown }).events;
    if (Array.isArray(events)) return events.filter(isTypedEvent);
    if (isTypedEvent(payload)) return [payload];
  }
  return [];
}

export class IngestEventPipeline {
  private orders: OrdersIngestService;

  constructor(
    private db: Database.Database,
    private now: () => number = () => Date.now(),
  ) {
    this.orders = new OrdersIngestService(db, now);
  }

  dispatch(
    memberId: string | null,
    events: TypedEvent[],
    source: IngestEventSource,
  ): DispatchResult {
    const ids: string[] = [];
    for (const event of events) {
      const id = this.dispatchOne(memberId, event, source);
      if (id) ids.push(id);
    }
    return { accepted: ids.length, ids };
  }

  private dispatchOne(
    memberId: string | null,
    event: TypedEvent,
    source: IngestEventSource,
  ): string | null {
    switch (event.type) {
      case 'order':
        return this.writeOrder(memberId, event, source);
      case 'txn_alert':
        return this.writeTxnAlert(memberId, event, source);
      case 'place_visit':
        return this.writePlaceVisit(memberId, event);
      case 'calendar_event':
        return this.writeCalendarEvent(memberId, event);
      case 'note':
        return this.writeNote(memberId, event);
      default:
        return null;
    }
  }

  private writeOrder(
    memberId: string | null,
    event: OrderEvent,
    source: IngestEventSource,
  ): string | null {
    if (source !== 'webhook' && source !== 'wallet' && !contextFlag('orders')) return null;
    const order: IngestOrder = {
      merchant: event.merchant,
      order_id: event.order_id,
      placed_at: event.placed_at,
      currency: event.currency,
      total_cents: centsFrom(event.total_cents, event.total),
      items: (event.items ?? []).map(toIngestItem),
    };
    const orderSource = source === 'owntracks' ? 'webhook' : source;
    const result = this.orders.ingest(memberId ?? '', [order], orderSource, {
      sourceHash: event.source_hash ?? null,
      looseMerchant: source === 'webhook' || source === 'wallet',
    });
    return result.ids[0] ?? null;
  }

  private writeTxnAlert(
    memberId: string | null,
    event: TxnAlertEvent,
    source: IngestEventSource,
  ): string | null {
    const hid = memberHousehold(this.db, memberId);
    const amountCents = centsFrom(event.amount_cents, event.amount);
    if (amountCents == null || !event.merchant) return null;
    const at = parseInstant(event.at) ?? this.now();
    const raw = JSON.stringify({
      type: 'txn_alert',
      merchant: event.merchant,
      amount_cents: amountCents,
      at,
      source,
    });
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    const existingDoc = this.db.prepare('SELECT hash FROM raw_documents WHERE hash = ?').get(hash) as
      | { hash: string }
      | undefined;
    if (!existingDoc) {
      this.db.prepare(`
        INSERT INTO raw_documents (hash, household_id, filename, mime_type, uploaded_at, size_bytes)
        VALUES (?, ?, ?, 'application/json', ?, ?)
      `).run(hash, hid, `webhook-alert-${hash.slice(0, 8)}.json`, this.now(), Buffer.byteLength(raw));
    }
    const obsId = crypto.randomBytes(8).toString('hex');
    this.db.prepare(`
      INSERT INTO observations (
        id, household_id, document_hash, account_hint, amount_cents, currency,
        fx_amount_cents, fx_currency, timestamp, merchant_text,
        reference, kind, adapter_name, is_statement, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, 'debit', 'webhook-alert', 0, ?)
    `).run(
      obsId,
      hid,
      hash,
      event.account_hint || 'unknown',
      amountCents,
      event.currency || 'SGD',
      at,
      event.merchant,
      event.event_id ?? null,
      this.now(),
    );
    attachAlertToExistingTransaction(this.db, {
      householdId: hid,
      observationId: obsId,
      amountCents,
      merchant: event.merchant,
      timestamp: at,
    });
    return obsId;
  }

  private writePlaceVisit(memberId: string | null, event: PlaceVisitEvent): string | null {
    if (!memberId || !event.place_name) return null;
    const arrived = parseInstant(event.arrived_at);
    if (arrived == null) return null;
    const left = parseInstant(event.left_at) ?? arrived;
    const hid = memberHousehold(this.db, memberId);
    const id = crypto.randomBytes(8).toString('hex');
    this.db.prepare(`
      INSERT INTO place_visits (
        id, household_id, member_id, lat, lng, arrived_at, left_at, place_name, place_source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'webhook', ?)
    `).run(
      id,
      hid,
      memberId,
      Number.isFinite(event.lat) ? event.lat : 0,
      Number.isFinite(event.lng) ? event.lng : 0,
      arrived,
      left,
      event.place_name,
      this.now(),
    );
    return id;
  }

  private writeCalendarEvent(memberId: string | null, event: CalendarEventEvent): string | null {
    if (!memberId || !event.title) return null;
    const starts = parseInstant(event.starts_at);
    if (starts == null) return null;
    const ends = parseInstant(event.ends_at) ?? starts;
    const hid = memberHousehold(this.db, memberId);
    const id = event.event_id
      ? `cal-hook-${crypto.createHash('sha256').update(`${memberId}:${event.event_id}`).digest('hex').slice(0, 16)}`
      : crypto.randomBytes(8).toString('hex');
    this.db.prepare(`
      INSERT INTO calendar_events (id, household_id, member_id, title, location, starts_at, ends_at, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        location = excluded.location,
        starts_at = excluded.starts_at,
        ends_at = excluded.ends_at,
        fetched_at = excluded.fetched_at
    `).run(id, hid, memberId, event.title, event.location ?? null, starts, ends, this.now());
    return id;
  }

  private writeNote(memberId: string | null, event: NoteEvent): string | null {
    if (!event.text) return null;
    const hid = memberHousehold(this.db, memberId);
    const txId = matchNoteTransaction(this.db, hid, event);
    if (!txId) return null;
    const sourceId = event.event_id
      ? `note-${event.event_id}`.slice(0, 40)
      : crypto.randomBytes(8).toString('hex');
    this.db.prepare(`
      INSERT INTO context_links (
        id, household_id, transaction_id, kind, source_id, confidence, snippet, proposed_split, status, created_at
      ) VALUES (?, ?, ?, 'note', ?, 0.7, ?, NULL, 'proposed', ?)
      ON CONFLICT(transaction_id, kind, source_id) DO UPDATE SET
        snippet = excluded.snippet
    `).run(crypto.randomBytes(8).toString('hex'), hid, txId, sourceId, event.text.slice(0, 240), this.now());
    return sourceId;
  }
}

function toIngestItem(item: OrderItemEvent): IngestOrderItem {
  const unit = centsFrom(item.unit_cents, item.unit_price);
  return {
    name: item.name,
    qty: item.qty ?? 1,
    unit_cents: unit,
    line_cents: item.line_cents ?? (unit != null ? Math.round(unit * (item.qty ?? 1)) : null),
  };
}

function centsFrom(cents: number | undefined, major: number | undefined): number | null {
  if (typeof cents === 'number' && Number.isFinite(cents)) return Math.round(cents);
  if (typeof major === 'number' && Number.isFinite(major)) return Math.round(major * 100);
  return null;
}

export function parseInstant(raw: number | string | null | undefined): number | null {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw < 1e12 ? raw * 1000 : raw;
  const ms = Date.parse(String(raw));
  return Number.isFinite(ms) ? ms : null;
}

function memberHousehold(db: Database.Database, memberId: string | null): string {
  if (!memberId) return hh();
  return householdIdForMember(db, memberId) ?? hh();
}

function attachAlertToExistingTransaction(
  db: Database.Database,
  opts: { householdId: string; observationId: string; amountCents: number; merchant: string; timestamp: number },
): void {
  const windowMs = 2 * 24 * 60 * 60 * 1000;
  const token = opts.merchant.replace(/[^A-Za-z0-9]+/g, '%').slice(0, 24);
  const row = db.prepare(`
    SELECT id, observation_ids FROM transactions
    WHERE household_id = ?
      AND timestamp BETWEEN ? AND ?
      AND ABS(amount_cents - ?) <= 1
      AND merchant_text LIKE ?
    ORDER BY ABS(timestamp - ?) ASC
    LIMIT 1
  `).get(
    opts.householdId,
    opts.timestamp - windowMs,
    opts.timestamp + windowMs,
    opts.amountCents,
    `%${token}%`,
    opts.timestamp,
  ) as { id: string; observation_ids: string } | undefined;
  if (!row) return;
  const ids = JSON.parse(row.observation_ids || '[]') as string[];
  if (ids.includes(opts.observationId)) return;
  ids.push(opts.observationId);
  db.prepare(
    'UPDATE transactions SET observation_ids = ?, updated_at = ? WHERE id = ? AND household_id = ?',
  ).run(JSON.stringify(ids), Date.now(), row.id, opts.householdId);
}

function matchNoteTransaction(
  db: Database.Database,
  householdId: string,
  event: NoteEvent,
): string | null {
  const hints = event.match ?? {};
  const amount = centsFrom(hints.amount_cents, hints.amount);
  const at = parseInstant(hints.at);
  const merchant = (hints.merchant || '').trim();
  if (!merchant && amount == null && at == null) return null;
  const clauses: string[] = ['household_id = ?'];
  const params: unknown[] = [householdId];
  if (amount != null) {
    clauses.push('ABS(amount_cents - ?) <= 1');
    params.push(amount);
  }
  if (at != null) {
    clauses.push('timestamp BETWEEN ? AND ?');
    params.push(at - 2 * 24 * 60 * 60 * 1000, at + 2 * 24 * 60 * 60 * 1000);
  }
  if (merchant) {
    clauses.push('merchant_text LIKE ?');
    params.push(`%${merchant.slice(0, 24)}%`);
  }
  const row = db.prepare(
    `SELECT id FROM transactions WHERE ${clauses.join(' AND ')} ORDER BY timestamp DESC LIMIT 1`,
  ).get(...params) as { id: string } | undefined;
  return row?.id ?? null;
}

export function ordersToTypedEvents(
  orders: IngestOrder[],
  sourceHash?: string | null,
): OrderEvent[] {
  return orders.map((order) => ({
    type: 'order' as const,
    version: 1 as const,
    merchant: order.merchant,
    order_id: order.order_id,
    placed_at: order.placed_at,
    currency: order.currency,
    total_cents: order.total_cents ?? undefined,
    source_hash: sourceHash,
    items: (order.items ?? []).map((item) => ({
      name: item.name,
      qty: item.qty,
      unit_cents: item.unit_cents ?? undefined,
      line_cents: item.line_cents ?? undefined,
    })),
  }));
}
