import type { Hono } from 'hono';
type App = Hono<{ Variables: { authUser: string; householdId: string } }>;
import type { ConnectionsService, SourceKind } from '../services/context/connections-service.js';
import { householdIdForMember, resolveCurrentMember } from '../lib/member-identity.js';
import { DEFAULT_HOUSEHOLD_ID, runWithHousehold } from '../lib/tenancy.js';
import { verifyEmailHmac } from '../lib/email-hmac.js';
import { logger } from '../lib/logger.js';
import { OrdersIngestService } from '../services/context/orders-ingest.js';
import type { OrderMatchService } from '../services/context/order-match.js';
import { isOrderSyncState, OrderSyncStateStore } from '../services/context/order-sync-state.js';
import type Database from 'better-sqlite3';
import type { TriangulateService } from '../services/context/triangulate.js';
import { IngestEventPipeline, ordersToTypedEvents } from '../services/context/ingest-events.js';
import type { IngestOrder } from '../services/context/orders-ingest.js';

const SOURCES: SourceKind[] = ['email', 'calendar', 'location', 'extension', 'webhook'];

function originFrom(c: { req: { header: (name: string) => string | undefined; url: string } }): string {
  if (process.env.PUBLIC_ORIGIN) return process.env.PUBLIC_ORIGIN.replace(/\/$/, '');
  try {
    return new URL(c.req.url).origin;
  } catch {
    const host = c.req.header('host') || 'localhost:3100';
    return `http://${host}`;
  }
}

export function registerConnectionRoutes(
  app: App,
  deps: {
    db: Database.Database;
    connections: ConnectionsService;
    authMode: string;
  },
): void {
  const memberOf = (c: { get: (k: string) => unknown }) =>
    resolveCurrentMember(deps.db, c.get('authUser') as string | undefined);

  app.get('/api/connections', (c) => {
    const snap = deps.connections.snapshot(c.get('authUser') as string | undefined, originFrom(c));
    if (!snap) return c.json({ error: 'No household member' }, 404);
    return c.json(snap);
  });

  app.post('/api/connections/email', (c) => {
    const member = memberOf(c);
    if (!member) return c.json({ error: 'No household member' }, 404);
    try {
      return c.json(deps.connections.enableMailbox(member));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Could not enable' }, 400);
    }
  });

  app.post('/api/connections/email/regenerate', (c) => {
    const member = memberOf(c);
    if (!member) return c.json({ error: 'No household member' }, 404);
    try {
      return c.json(deps.connections.regenerateMailbox(member));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Could not regenerate' }, 400);
    }
  });

  app.post('/api/connections/calendar', async (c) => {
    const member = memberOf(c);
    if (!member) return c.json({ error: 'No household member' }, 404);
    const body = await c.req.json().catch(() => ({})) as { url?: string };
    const url = typeof body.url === 'string' ? body.url : '';
    const result = await deps.connections.saveCalendar(member.id, url);
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ ok: true });
  });

  app.post('/api/connections/location', (c) => {
    const member = memberOf(c);
    if (!member) return c.json({ error: 'No household member' }, 404);
    const minted = deps.connections.mintLocation(member);
    return c.json({
      ...minted,
      url: `${originFrom(c)}/api/ingest/location`,
    });
  });

  app.post('/api/connections/extension', (c) => {
    const member = memberOf(c);
    if (!member) return c.json({ error: 'No household member' }, 404);
    const minted = deps.connections.mintExtension(member);
    return c.json({
      ...minted,
      origin: originFrom(c),
      ingestUrl: `${originFrom(c)}/api/ingest/orders`,
    });
  });

  app.post('/api/connections/:kind/disconnect', async (c) => {
    const member = memberOf(c);
    if (!member) return c.json({ error: 'No household member' }, 404);
    const kind = c.req.param('kind') as SourceKind;
    if (!SOURCES.includes(kind)) return c.json({ error: 'Unknown source' }, 404);
    const body = await c.req.json().catch(() => ({})) as { deleteData?: boolean };
    deps.connections.disconnect(member.id, kind, body.deleteData !== false);
    return c.json({ ok: true });
  });

  app.post('/api/dev/seed-connections', async (c) => {
    if (deps.authMode !== 'none') return c.json({ error: 'Synthetic seed is disabled' }, 403);
    const member = memberOf(c);
    if (!member) return c.json({ error: 'No household member' }, 404);
    const body = await c.req.json().catch(() => ({})) as { scenario?: 'empty' | 'mixed' };
    const { seedConnectionsScenario } = await import('../services/context/connections-service.js');
    seedConnectionsScenario(deps.db, member.id, body.scenario === 'mixed' ? 'mixed' : 'empty');
    return c.json({ ok: true, scenario: body.scenario === 'mixed' ? 'mixed' : 'empty' });
  });
}

/** Max orders accepted in one signed request (the importer sends batches of 200). */
export const SIGNED_ORDERS_MAX_BATCH = 1000;

/**
 * Wire contract for signed order imports (one JSONL line per order):
 * {"shop":"lazada|shopee|amazon","order_id":"...","placed_at":"YYYY-MM-DD"|null,"currency":"SGD",
 *  "total_cents":123,"status":"...","buyer_account":"...","items":[{"title":"...","qty":1,
 *  "unit_price_cents":123|null,"sku":null,"url":null}]}
 */
export interface SignedOrderLine {
  shop?: unknown;
  order_id?: unknown;
  placed_at?: unknown;
  currency?: unknown;
  total_cents?: unknown;
  status?: unknown;
  buyer_account?: unknown;
  raw?: unknown;
  items?: unknown;
}

function str(value: unknown, max = 500): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function int(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

export function signedLineToOrder(line: SignedOrderLine): IngestOrder | null {
  if (!line || typeof line !== 'object') return null;
  const shop = str(line.shop, 48);
  const orderId = str(line.order_id, 128);
  if (!shop || !orderId) return null;
  const placed = line.placed_at == null ? null : str(line.placed_at, 40) ?? int(line.placed_at);
  const items = Array.isArray(line.items) ? line.items : [];
  return {
    merchant: shop,
    order_id: orderId,
    placed_at: placed,
    currency: (str(line.currency, 8) ?? 'SGD').toUpperCase(),
    total_cents: int(line.total_cents),
    status: str(line.status, 80),
    buyer_account: str(line.buyer_account, 200),
    raw: line.raw === undefined ? undefined : line.raw,
    items: items.slice(0, 200).flatMap((raw) => {
      const item = raw as Record<string, unknown>;
      const title = str(item?.title ?? item?.name, 500);
      if (!title) return [];
      const qty = typeof item.qty === 'number' && Number.isFinite(item.qty) && item.qty > 0 ? item.qty : 1;
      const unit = int(item.unit_price_cents ?? item.unit_cents);
      return [{
        name: title,
        qty,
        unit_cents: unit,
        line_cents: unit != null ? Math.round(unit * qty) : null,
        sku: str(item.sku, 200),
        url: str(item.url, 1000),
      }];
    }),
  };
}

export function registerOrdersIngestRoute(
  app: App,
  deps: {
    db: Database.Database;
    connections: ConnectionsService;
    triangulate: Pick<TriangulateService, 'forRecentTransactions'>;
    orderMatch?: OrderMatchService;
    /** EMAIL_INGEST_HMAC_SECRET: enables signed bulk/sync imports (X-OE-Signature). */
    hmacSecret?: string;
  },
): void {
  const pipeline = new IngestEventPipeline(deps.db);
  const signedIngest = new OrdersIngestService(deps.db);

  const resolveSignedTarget = (recipient: string | undefined): { householdId: string; memberId: string | null } | 'unknown' | 'ambiguous' => {
    if (recipient) {
      const mailbox = deps.connections.mailboxForRecipient(recipient);
      if (!mailbox) return 'unknown';
      return { householdId: mailbox.householdId || DEFAULT_HOUSEHOLD_ID, memberId: mailbox.memberId };
    }
    // No recipient: only safe on a single-household install, mirroring the email path's default household.
    const rows = deps.db.prepare('SELECT id FROM households').all() as Array<{ id: string }>;
    if (rows.length > 1) return 'ambiguous';
    return { householdId: rows[0]?.id ?? DEFAULT_HOUSEHOLD_ID, memberId: null };
  };

  app.post('/api/ingest/orders', async (c) => {
    const rawBody = Buffer.from(await c.req.arrayBuffer());
    const signature = c.req.header('X-OE-Signature');
    if (signature !== undefined) {
      // Signed bulk/sync import: same HMAC model as /api/ingest/email.
      if (!deps.hmacSecret || !verifyEmailHmac(deps.hmacSecret, rawBody, signature)) {
        logger.warn('Unauthorized signed orders ingest');
        return new Response(null, { status: 401 });
      }
      const target = resolveSignedTarget(c.req.header('X-OE-Recipient'));
      if (target === 'unknown') return new Response(null, { status: 401 });
      if (target === 'ambiguous') return c.json({ error: 'X-OE-Recipient required on multi-household installs' }, 400);
      let body: unknown;
      try {
        body = JSON.parse(rawBody.toString('utf8'));
      } catch {
        return c.json({ error: 'Invalid JSON' }, 400);
      }
      const lines = Array.isArray(body) ? body : Array.isArray((body as { orders?: unknown })?.orders) ? (body as { orders: unknown[] }).orders : null;
      if (!lines) return c.json({ error: 'Expected an array of orders or {"orders":[...]}' }, 400);
      if (lines.length > SIGNED_ORDERS_MAX_BATCH) return c.json({ error: `At most ${SIGNED_ORDERS_MAX_BATCH} orders per request` }, 413);
      const orders = lines.map((line) => signedLineToOrder(line as SignedOrderLine));
      const valid = orders.filter((order): order is IngestOrder => order !== null);
      const result = runWithHousehold(target.householdId, () => {
        const write = deps.db.transaction(() => signedIngest.ingest(target.memberId ?? '', valid, 'import', {
          householdId: target.householdId,
          looseMerchant: false,
        }));
        const ingested = write();
        const summary = deps.orderMatch?.matchHousehold(target.householdId);
        const matched = deps.orderMatch ? deps.orderMatch.matchedCount(ingested.ids) : 0;
        return { ingested, matched, ambiguous: summary?.ambiguous ?? 0 };
      });
      return c.json({
        received: lines.length,
        rejected: lines.length - result.ingested.accepted,
        inserted: result.ingested.inserted,
        updated: result.ingested.updated,
        matched: result.matched,
        unmatched: result.ingested.accepted - result.matched,
      });
    }

    const header = c.req.header('Authorization') || '';
    const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    const memberId = deps.connections.verifyExtensionToken(token);
    if (!memberId) return new Response(null, { status: 401 });
    const householdId = householdIdForMember(deps.db, memberId);
    let body: { orders?: unknown } | unknown[] | null = null;
    try {
      body = JSON.parse(rawBody.toString('utf8')) as { orders?: unknown } | unknown[];
    } catch {
      body = null;
    }
    const orders = Array.isArray(body) ? body : Array.isArray(body?.orders) ? body.orders : [];
    const result = runWithHousehold(householdId || 'hh-none', () => {
      const accepted = pipeline.dispatch(
        memberId,
        ordersToTypedEvents(orders as IngestOrder[]),
        'extension',
      );
      if (accepted.accepted > 0) {
        deps.triangulate.forRecentTransactions();
        deps.orderMatch?.matchHousehold();
      }
      return accepted;
    });
    return c.json({ accepted: result.accepted }, 202);
  });

  // An always-on order sync reports its health per shop (signed like the import).
  const syncState = new OrderSyncStateStore(deps.db);
  app.post('/api/ingest/orders/sync-status', async (c) => {
    const rawBody = Buffer.from(await c.req.arrayBuffer());
    if (!deps.hmacSecret || !verifyEmailHmac(deps.hmacSecret, rawBody, c.req.header('X-OE-Signature'))) {
      return new Response(null, { status: 401 });
    }
    const target = resolveSignedTarget(c.req.header('X-OE-Recipient'));
    if (target === 'unknown') return new Response(null, { status: 401 });
    if (target === 'ambiguous') return c.json({ error: 'X-OE-Recipient required on multi-household installs' }, 400);
    let body: { shop?: unknown; state?: unknown; detail?: unknown } | null;
    try {
      body = JSON.parse(rawBody.toString('utf8')) as { shop?: unknown; state?: unknown; detail?: unknown } | null;
    } catch {
      body = null;
    }
    const shop = typeof body?.shop === 'string' ? body.shop : '';
    const state = body?.state;
    if (!shop || !isOrderSyncState(state)) {
      return c.json({ error: 'Expected {"shop": string, "state": "ok|reauth_needed|blocked|error", "detail"?: string}' }, 400);
    }
    syncState.report(target.householdId, {
      shop,
      state,
      detail: typeof body?.detail === 'string' ? body.detail : null,
    });
    return c.json({ ok: true });
  });
}
