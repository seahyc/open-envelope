import type { Hono } from 'hono';
type App = Hono<{ Variables: { authUser: string; householdId: string } }>;
import type { HooksService } from '../services/context/hooks-service.js';
import type { TriangulateService } from '../services/context/triangulate.js';
import { householdIdForMember, resolveCurrentMember } from '../lib/member-identity.js';
import { runWithHousehold } from '../lib/tenancy.js';
import type Database from 'better-sqlite3';

function empty(status: number): Response {
  return new Response(null, { status });
}

export function registerHookIngestRoute(
  app: App,
  deps: {
    db: Database.Database;
    hooks: HooksService;
    triangulate: Pick<TriangulateService, 'forRecentTransactions'>;
  },
): void {
  app.options('/api/hooks/:hookId', (c) => {
    c.header('Access-Control-Allow-Origin', '*');
    c.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    c.header(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-OE-Hook-Timestamp, X-OE-Hook-Signature',
    );
    return c.body(null, 204);
  });

  app.post('/api/hooks/:hookId', async (c) => {
    const raw = Buffer.from(await c.req.arrayBuffer());
    const hookId = c.req.param('hookId');
    const result = deps.hooks.ingest(hookId, {
      signature: c.req.header('X-OE-Hook-Signature'),
      timestamp: c.req.header('X-OE-Hook-Timestamp'),
      authorization: c.req.header('Authorization'),
    }, raw);
    if (result.body == null) return empty(result.status);
    const hook = deps.db.prepare(
      'SELECT member_id FROM ingest_hooks WHERE id = ?',
    ).get(hookId) as { member_id: string } | undefined;
    if (result.status === 202 && (result.body.accepted as number) > 0 && hook) {
      const householdId = householdIdForMember(deps.db, hook.member_id);
      runWithHousehold(householdId || 'hh-none', () => {
        deps.triangulate.forRecentTransactions();
      });
    }
    return c.json(result.body, result.status as 202);
  });
}

export function registerWebhookConnectionRoutes(
  app: App,
  deps: {
    db: Database.Database;
    hooks: HooksService;
    triangulate: Pick<TriangulateService, 'forRecentTransactions'>;
  },
): void {
  const memberOf = (c: { get: (k: string) => unknown }) =>
    resolveCurrentMember(deps.db, c.get('authUser') as string | undefined);

  const originFrom = (c: { req: { header: (name: string) => string | undefined; url: string } }): string => {
    if (process.env.PUBLIC_ORIGIN) return process.env.PUBLIC_ORIGIN.replace(/\/$/, '');
    try {
      return new URL(c.req.url).origin;
    } catch {
      const host = c.req.header('host') || 'localhost:3100';
      return `http://${host}`;
    }
  };

  app.post('/api/connections/webhooks', async (c) => {
    const member = memberOf(c);
    if (!member) return c.json({ error: 'No household member' }, 404);
    const body = await c.req.json().catch(() => ({})) as { name?: string };
    try {
      const minted = deps.hooks.mint(member.id, body.name || 'Webhook', originFrom(c));
      return c.json(minted);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Could not create hook' }, 400);
    }
  });

  app.post('/api/connections/webhooks/:id/mapping', async (c) => {
    const member = memberOf(c);
    if (!member) return c.json({ error: 'No household member' }, 404);
    const body = await c.req.json().catch(() => ({})) as { mapping?: string };
    const result = deps.hooks.saveMapping(member.id, c.req.param('id'), body.mapping || '');
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ ok: true });
  });

  app.post('/api/connections/webhooks/:id/test', async (c) => {
    const member = memberOf(c);
    if (!member) return c.json({ error: 'No household member' }, 404);
    const payload = await c.req.json().catch(() => null);
    const result = deps.hooks.sendTest(member.id, c.req.param('id'), payload);
    if (result.status === 202 && (result.body?.accepted as number) > 0) {
      deps.triangulate.forRecentTransactions();
    }
    if (result.body == null) return new Response(null, { status: result.status });
    return c.json(result.body, result.status as 202);
  });

  app.post('/api/connections/webhooks/:id/disconnect', async (c) => {
    const member = memberOf(c);
    if (!member) return c.json({ error: 'No household member' }, 404);
    const body = await c.req.json().catch(() => ({})) as { deleteData?: boolean };
    deps.hooks.disconnect(member.id, c.req.param('id'), body.deleteData !== false);
    return c.json({ ok: true });
  });
}
