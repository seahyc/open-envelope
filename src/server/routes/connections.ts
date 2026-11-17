import type { Hono } from 'hono';
type App = Hono<{ Variables: { authUser: string; householdId: string } }>;
import type { ConnectionsService, SourceKind } from '../services/context/connections-service.js';
import { householdIdForMember, resolveCurrentMember } from '../lib/member-identity.js';
import { runWithHousehold } from '../lib/tenancy.js';
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

export function registerOrdersIngestRoute(
  app: App,
  deps: {
    db: Database.Database;
    connections: ConnectionsService;
    triangulate: Pick<TriangulateService, 'forRecentTransactions'>;
  },
): void {
  const pipeline = new IngestEventPipeline(deps.db);
  app.post('/api/ingest/orders', async (c) => {
    const header = c.req.header('Authorization') || '';
    const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    const memberId = deps.connections.verifyExtensionToken(token);
    if (!memberId) return new Response(null, { status: 401 });
    const householdId = householdIdForMember(deps.db, memberId);
    const body = await c.req.json().catch(() => null) as { orders?: unknown } | null;
    const orders = Array.isArray(body?.orders) ? body.orders : Array.isArray(body) ? body : [];
    const result = runWithHousehold(householdId || 'hh-none', () => {
      const accepted = pipeline.dispatch(
        memberId,
        ordersToTypedEvents(orders as IngestOrder[]),
        'extension',
      );
      if (accepted.accepted > 0) deps.triangulate.forRecentTransactions();
      return accepted;
    });
    return c.json({ accepted: result.accepted }, 202);
  });
}
