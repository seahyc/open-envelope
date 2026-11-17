import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { contextFlag } from '../../lib/context-flags.js';
import {
  hookTimestampFresh,
  parseBearerSecret,
  parseHookSignature,
  verifyHookHmac,
} from '../../lib/hook-hmac.js';
import { contextSecretKey, sealString, unsealString } from '../../lib/sealed-secret.js';
import { householdIdForMember } from '../../lib/member-identity.js';
import { hh } from '../../lib/tenancy.js';
import { applyMapping, previewMapping, type MappingSpec } from './hook-mapping.js';
import {
  extractTypedEvents,
  IngestEventPipeline,
  isTypedEvent,
  type TypedEvent,
} from './ingest-events.js';

export const HOOK_MAX_BYTES = 256 * 1024;
export const HOOK_RATE_MAX = 60;
const RATE_WINDOW_MS = 60_000;

export interface HookCard {
  id: string;
  name: string;
  url: string;
  lastReceivedAt: number | null;
  receivedCount: number;
  errorCount: number;
  error: string | null;
  mapping: string;
  lastSample: string | null;
  preview: unknown;
  previewError: string | null;
}

export interface HookIngestResult {
  status: number;
  body: Record<string, unknown> | null;
}

interface HookRow {
  id: string;
  household_id: string;
  member_id: string;
  name: string;
  secret_enc: string;
  mapping: string | null;
  last_received_at: number | null;
  last_error: string | null;
  received_count: number;
  error_count: number;
  last_sample: string | null;
}

export class HooksService {
  private hits = new Map<string, number[]>();
  private seenSig = new Map<string, number>();
  private pipeline: IngestEventPipeline;

  constructor(
    private db: Database.Database,
    private now: () => number = () => Date.now(),
  ) {
    this.pipeline = new IngestEventPipeline(db, now);
  }

  list(memberId: string, publicOrigin: string): HookCard[] {
    const rows = this.db.prepare(
      `SELECT id, name, mapping, last_received_at, last_error, received_count, error_count, last_sample
       FROM ingest_hooks WHERE member_id = ? ORDER BY created_at`,
    ).all(memberId) as Array<{
      id: string;
      name: string;
      mapping: string | null;
      last_received_at: number | null;
      last_error: string | null;
      received_count: number;
      error_count: number;
      last_sample: string | null;
    }>;
    const origin = publicOrigin.replace(/\/$/, '');
    return rows.map((row) => {
      const mapping = parseMapping(row.mapping);
      const sample = parseJson(row.last_sample);
      const previewed = previewMapping(sample, mapping);
      return {
        id: row.id,
        name: row.name,
        url: `${origin}/api/hooks/${row.id}`,
        lastReceivedAt: row.last_received_at,
        receivedCount: row.received_count,
        errorCount: row.error_count,
        error: row.last_error,
        mapping: row.mapping || '',
        lastSample: row.last_sample,
        preview: previewed.preview,
        previewError: previewed.error,
      };
    });
  }

  mint(memberId: string, name: string, publicOrigin: string): { id: string; name: string; url: string; secret: string } {
    const key = contextSecretKey();
    if (!key) throw new Error('CONTEXT_SECRET_KEY is not set');
    const id = crypto.randomBytes(12).toString('hex');
    const secret = crypto.randomBytes(24).toString('base64url');
    const hid = householdIdForMember(this.db, memberId) ?? hh();
    const label = name.trim() || 'Webhook';
    this.db.prepare(`
      INSERT INTO ingest_hooks (
        id, household_id, member_id, name, secret_enc, mapping, created_at,
        received_count, error_count
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, 0, 0)
    `).run(id, hid, memberId, label, sealString(secret, key), this.now());
    return {
      id,
      name: label,
      url: `${publicOrigin.replace(/\/$/, '')}/api/hooks/${id}`,
      secret,
    };
  }

  saveMapping(memberId: string, hookId: string, mappingText: string): { ok: true } | { ok: false; error: string } {
    const hook = this.owned(memberId, hookId);
    if (!hook) return { ok: false, error: 'Unknown hook' };
    const trimmed = mappingText.trim();
    if (!trimmed) {
      this.db.prepare('UPDATE ingest_hooks SET mapping = NULL WHERE id = ?').run(hookId);
      return { ok: true };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { ok: false, error: 'Mapping must be JSON' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'Mapping must be a JSON object' };
    }
    this.db.prepare('UPDATE ingest_hooks SET mapping = ? WHERE id = ?').run(JSON.stringify(parsed), hookId);
    return { ok: true };
  }

  disconnect(memberId: string, hookId: string | null, deleteData: boolean): void {
    const hooks = hookId
      ? [this.owned(memberId, hookId)].filter((row): row is HookRow => Boolean(row))
      : (this.db.prepare('SELECT * FROM ingest_hooks WHERE member_id = ?').all(memberId) as HookRow[]);
    for (const hook of hooks) {
      this.db.prepare('DELETE FROM ingest_hook_events WHERE hook_id = ?').run(hook.id);
      this.db.prepare('DELETE FROM ingest_hooks WHERE id = ?').run(hook.id);
    }
    if (deleteData) {
      const orders = this.db.prepare(
        "SELECT id FROM orders WHERE member_id = ? AND source = 'webhook'",
      ).all(memberId) as Array<{ id: string }>;
      for (const order of orders) {
        this.db.prepare('DELETE FROM order_items WHERE order_id = ?').run(order.id);
        this.db.prepare('DELETE FROM orders WHERE id = ?').run(order.id);
      }
      this.db.prepare("DELETE FROM place_visits WHERE member_id = ? AND place_source = 'webhook'").run(memberId);
    }
  }

  sendTest(memberId: string, hookId: string, payload: unknown): HookIngestResult {
    const hook = this.owned(memberId, hookId);
    if (!hook) return { status: 404, body: { error: 'Unknown hook' } };
    const raw = Buffer.from(JSON.stringify(payload ?? {}), 'utf8');
    return this.processAuthenticated(hook, raw, payload, null);
  }

  ingest(hookId: string, headers: {
    signature?: string | null;
    timestamp?: string | null;
    authorization?: string | null;
  }, raw: Buffer): HookIngestResult {
    if (raw.length > HOOK_MAX_BYTES) return { status: 413, body: null };
    const hook = this.db.prepare('SELECT * FROM ingest_hooks WHERE id = ?').get(hookId) as HookRow | undefined;
    const key = contextSecretKey();
    if (!hook || !key) return { status: 401, body: null };

    let secret: string;
    try {
      secret = unsealString(hook.secret_enc, key);
    } catch {
      return { status: 401, body: null };
    }

    const hmacHeader = headers.signature ?? null;
    const timestamp = headers.timestamp ?? null;
    const bearer = parseBearerSecret(headers.authorization);
    const usingHmac = Boolean(hmacHeader);
    if (usingHmac) {
      if (!hookTimestampFresh(timestamp, this.now())) return { status: 401, body: null };
      if (!verifyHookHmac(secret, timestamp!.trim(), raw, hmacHeader)) return { status: 401, body: null };
      const sig = parseHookSignature(hmacHeader);
      if (sig && this.signatureReplayed(hook.id, sig)) return { status: 401, body: null };
      if (sig) this.rememberSignature(hook.id, sig);
    } else if (!bearer || bearer !== secret) {
      return { status: 401, body: null };
    }

    if (this.overLimit(hook.id)) return { status: 429, body: null };
    if (!contextFlag('webhook')) return { status: 404, body: null };

    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      this.markError(hook.id, 'body was not JSON');
      return { status: 400, body: { error: 'JSON body required' } };
    }
    return this.processAuthenticated(hook, raw, payload, eventKeyFrom(payload, raw));
  }

  private processAuthenticated(
    hook: HookRow,
    raw: Buffer,
    payload: unknown,
    eventKey: string | null,
  ): HookIngestResult {
    const mapping = parseMapping(hook.mapping);
    let mapped: unknown = payload;
    if (mapping) {
      try {
        mapped = applyMapping(payload, mapping);
      } catch {
        this.storeEvent(hook, raw, null, eventKeyFrom(payload, raw), 'error', 'mapping failed');
        this.markError(hook.id, 'mapping failed');
        return { status: 400, body: { error: 'Could not map payload' } };
      }
    }
    const events = extractTypedEvents(mapped);
    if (events.length === 0 && isTypedEvent(mapped)) events.push(mapped);
    if (events.length === 0) {
      this.storeEvent(hook, raw, mapped, eventKeyFrom(payload, raw), 'error', 'not a typed event');
      this.markError(hook.id, 'payload was not a typed event');
      return { status: 400, body: { error: 'Not a typed event' } };
    }
    const key = eventKey ?? eventKeyFrom(events[0], raw);
    if (this.alreadySeen(hook.id, key)) {
      this.touchReceived(hook.id, payload);
      return { status: 202, body: { accepted: 0, duplicate: true } };
    }
    const dispatched = this.pipeline.dispatch(hook.member_id, events as TypedEvent[], 'webhook');
    this.storeEvent(hook, raw, mapped, key, dispatched.accepted > 0 ? 'accepted' : 'error', null);
    this.touchReceived(hook.id, payload);
    if (dispatched.accepted === 0) {
      this.markError(hook.id, 'event was not stored');
      return { status: 202, body: { accepted: 0, event_ids: dispatched.ids } };
    }
    this.clearError(hook.id);
    return { status: 202, body: { accepted: dispatched.accepted, event_ids: dispatched.ids } };
  }

  private owned(memberId: string, hookId: string): HookRow | undefined {
    return this.db.prepare(
      'SELECT * FROM ingest_hooks WHERE id = ? AND member_id = ?',
    ).get(hookId, memberId) as HookRow | undefined;
  }

  private alreadySeen(hookId: string, eventKey: string): boolean {
    const row = this.db.prepare(
      'SELECT id FROM ingest_hook_events WHERE hook_id = ? AND event_key = ?',
    ).get(hookId, eventKey) as { id: string } | undefined;
    return Boolean(row);
  }

  private storeEvent(
    hook: HookRow,
    raw: Buffer,
    mapped: unknown,
    eventKey: string,
    status: string,
    error: string | null,
  ): void {
    try {
      this.db.prepare(`
        INSERT INTO ingest_hook_events (
          id, household_id, hook_id, event_key, status, raw_json, mapped_json, error, received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        crypto.randomBytes(8).toString('hex'),
        hook.household_id,
        hook.id,
        eventKey,
        status,
        raw.toString('utf8').slice(0, HOOK_MAX_BYTES),
        mapped == null ? null : JSON.stringify(mapped).slice(0, HOOK_MAX_BYTES),
        error,
        this.now(),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/UNIQUE/i.test(message)) throw err;
    }
  }

  private touchReceived(hookId: string, payload: unknown): void {
    this.db.prepare(`
      UPDATE ingest_hooks
      SET last_received_at = ?, received_count = received_count + 1, last_sample = ?, last_error = NULL
      WHERE id = ?
    `).run(this.now(), JSON.stringify(payload).slice(0, HOOK_MAX_BYTES), hookId);
  }

  private markError(hookId: string, message: string): void {
    this.db.prepare(`
      UPDATE ingest_hooks
      SET last_error = ?, error_count = error_count + 1
      WHERE id = ?
    `).run(message, hookId);
  }

  private clearError(hookId: string): void {
    this.db.prepare('UPDATE ingest_hooks SET last_error = NULL WHERE id = ?').run(hookId);
  }

  private overLimit(hookId: string): boolean {
    const now = this.now();
    const recent = (this.hits.get(hookId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (recent.length >= HOOK_RATE_MAX) {
      this.hits.set(hookId, recent);
      return true;
    }
    recent.push(now);
    this.hits.set(hookId, recent);
    return false;
  }

  private signatureReplayed(hookId: string, signature: string): boolean {
    const key = `${hookId}:${signature}`;
    const seenAt = this.seenSig.get(key);
    if (seenAt == null) return false;
    return this.now() - seenAt < 300_000;
  }

  private rememberSignature(hookId: string, signature: string): void {
    const now = this.now();
    this.seenSig.set(`${hookId}:${signature}`, now);
    for (const [key, at] of this.seenSig) {
      if (now - at > 300_000) this.seenSig.delete(key);
    }
  }
}

function parseMapping(raw: string | null): MappingSpec | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as MappingSpec;
  } catch {
    /* ignore */
  }
  return null;
}

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export function eventKeyFrom(payload: unknown, raw: Buffer): string {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const id = (payload as { event_id?: unknown }).event_id;
    if (typeof id === 'string' && id.trim()) return `id:${id.trim()}`.slice(0, 120);
    const events = (payload as { events?: unknown }).events;
    if (Array.isArray(events) && events[0] && typeof events[0] === 'object') {
      const inner = (events[0] as { event_id?: unknown }).event_id;
      if (typeof inner === 'string' && inner.trim()) return `id:${inner.trim()}`.slice(0, 120);
    }
  }
  return `hash:${crypto.createHash('sha256').update(raw).digest('hex')}`;
}
