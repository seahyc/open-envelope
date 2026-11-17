import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { initDatabase } from './db/database.js';
import { LocalDocumentStore } from './storage/document-store.js';
import { ImportService } from './services/import-service.js';
import { TransactionService } from './services/transaction-service.js';
import { BudgetService } from './services/budget-service.js';
import { TransferService } from './services/transfer-service.js';
import { ReconciliationService } from './services/reconciliation-service.js';
import { OnboardingService } from './services/onboarding-service.js';
import { ReviewService } from './services/review-service.js';
import { seedUiFixtures } from './services/ui-seed.js';
import { HomeService } from './services/home-service.js';
import { loadConfig } from './lib/config.js';
import { logger } from './lib/logger.js';
import { assertNotLLMSourced } from './lib/llm-guards.js';
import { assertProductionAuthConfig, validateAuth } from './lib/auth.js';
import { defaultRegistry } from './adapters/registry.js';
import { PipelineService } from './services/pipeline-service.js';
import { buildPipelineGraphPayload } from './pipeline/graph.js';
import { LLMProvider } from './lib/llm-provider.js';
import { LLMTriageService } from './services/llm-triage-service.js';
import { readFileSync, existsSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import crypto from 'crypto';
import { contextFlag } from './lib/context-flags.js';
import { LocationIngestService } from './services/context/location-ingest.js';
import { CalendarPollService } from './services/context/calendar-poll.js';
import { parseReceiptEmail } from './services/context/order-parsers.js';
import { purgeOldInboundMail, purgeOldHookEvents, purgeOldLocationPoints } from './services/context/retention.js';
import { PushService, webPushEnabled } from './services/push-service.js';
import { authorizeEmailIngest } from './lib/email-hmac.js';
import { parseGmailForwardingVerify } from './services/context/gmail-verify.js';
import { resolveEmailAlert } from './services/email-alert-ingest.js';
import { ConnectionsService } from './services/context/connections-service.js';
import { registerConnectionRoutes, registerOrdersIngestRoute } from './routes/connections.js';
import { registerHookIngestRoute, registerWebhookConnectionRoutes } from './routes/hooks.js';
import { HooksService } from './services/context/hooks-service.js';
import { IngestEventPipeline } from './services/context/ingest-events.js';
import { DEFAULT_HOUSEHOLD_ID, hh, runWithHouseholdAsync } from './lib/tenancy.js';
import {
  resolveCurrentMember,
  resolveOrProvisionAccessMember,
  seedLegacyAccessMembers,
} from './lib/member-identity.js';
import { HouseholdService } from './services/household-service.js';
import {
  AuthService,
  clearSessionCookie,
  parseSessionCookie,
  sessionCookie,
} from './services/auth-service.js';
import { exchangeGoogleCode, googleAuthorizeUrl } from './lib/google-oauth.js';

interface AccountMapping {
  folderPattern?: string;
  accountHint?: string;
  accountAlias: string;
  accountId?: string;
}

function loadAccountMappings(path: string = process.env.ACCOUNTS_CONFIG || 'accounts.yaml'): AccountMapping[] {
  if (!existsSync(path)) {
    logger.warn(`accounts.yaml not found at ${path}`);
    return [];
  }
  
  try {
    const content = readFileSync(path, 'utf-8');
    const parsed = parseYaml(content) as { accounts?: AccountMapping[] };
    return parsed?.accounts || [];
  } catch (error) {
    logger.error('Failed to load accounts.yaml', { error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

const config = loadConfig();
assertProductionAuthConfig({
  mode: config.authMode,
  cfAccessTeamDomain: config.cfAccessTeamDomain,
  cfAccessAud: config.cfAccessAud,
  allowedEmails: config.allowedEmails,
  accessGate: config.accessGate,
});
const PORT = config.port;
const DATABASE_PATH = config.databasePath;
const STORAGE_PATH = config.objectStorageLocalPath;

const db = initDatabase(DATABASE_PATH);
const documentStore = new LocalDocumentStore(STORAGE_PATH);

const llmProvider = config.llmProvider !== 'none' 
  ? new LLMProvider({
      provider: config.llmProvider,
      codexBin: config.llmCodexBin,
      codexHome: config.llmCodexHome,
      codexModel: config.codexModel,
      codexReasoningEffort: config.codexReasoningEffort,
      cacheEnabled: config.llmCacheEnabled,
      timeout: config.llmTimeout,
      rateLimit: { requestsPerMinute: config.llmRateLimit },
    })
  : null;

const triageService = new LLMTriageService(llmProvider);
const accountMappings = loadAccountMappings();
const pipelineService = new PipelineService(db, llmProvider, accountMappings, documentStore);
const importService = new ImportService(db, documentStore, defaultRegistry, pipelineService);
const transactionService = new TransactionService(db);
const budgetService = new BudgetService(db);
const transferService = new TransferService(db);
const reconciliationService = new ReconciliationService(db);
const onboardingService = new OnboardingService(db);
const householdService = new HouseholdService(db);
householdService.ensureDefault();
if (config.authMode === 'header' && config.appMode !== 'hosted') {
  const seeded = seedLegacyAccessMembers(db, config.allowedEmails);
  if (seeded.length > 0) {
    logger.info('Seeded legacy hh-1 members from ALLOWED_EMAILS', { count: seeded.length });
  }
}
const authService = new AuthService(db);
const reviewService = new ReviewService(db, pipelineService.categoriser);
const homeService = new HomeService(db, pipelineService.categoriser.schema, (month) => budgetService.getReadyToAssign(month));
const locationIngest = new LocationIngestService(db);
const calendarPoll = new CalendarPollService(db);
const triangulate = pipelineService.triangulate;
const pushService = new PushService(db);
const connections = new ConnectionsService(db, calendarPoll, locationIngest);
const hooks = new HooksService(db);
const ingestEvents = new IngestEventPipeline(db);
locationIngest.bootstrapFromEnv();
calendarPoll.bootstrapFromEnv();

if (!process.env.VITEST) {
  setInterval(() => {
    void calendarPoll.poll().then((upserted) => {
      if (upserted > 0) triangulate.forRecentTransactions();
    });
    purgeOldLocationPoints(db);
    purgeOldInboundMail(db, (hash) => documentStore.deleteFile(hash));
    purgeOldHookEvents(db);
  }, 15 * 60 * 1000);
}

async function tryIngestOrder(emailText: string, documentHash: string, memberId?: string | null): Promise<string | null> {
  if (!contextFlag('orders')) return null;
  const parsed = await parseReceiptEmail(emailText);
  if (!parsed) return null;
  const result = ingestEvents.dispatch(memberId ?? null, [{
    type: 'order',
    version: 1,
    merchant: parsed.merchant,
    order_id: parsed.orderRef,
    placed_at: parsed.orderedAt,
    currency: parsed.currency,
    total_cents: parsed.totalCents ?? undefined,
    source_hash: documentHash,
    items: parsed.items.map((item) => ({
      name: item.name,
      qty: item.qty,
      unit_cents: item.unitCents ?? undefined,
      line_cents: item.lineCents ?? undefined,
    })),
  }], 'email');
  const orderId = result.ids[0] ?? null;
  if (orderId) triangulate.forRecentTransactions();
  return orderId;
}

async function persistResolvedEmail(
  raw: Buffer,
  filename: string,
  mimeType: string,
  documentHash: string,
  emailText: string,
  memberId: string | null,
): Promise<{ observationsCreated: number; method: string; confidence: number }> {
  const resolved = await resolveEmailAlert(raw, filename, mimeType, emailText, llmProvider);
  for (const obs of resolved.observations) {
    const obsId = crypto.randomBytes(8).toString('hex');
    db.prepare(`
      INSERT INTO observations (
        id, household_id, document_hash, account_hint, amount_cents, currency,
        fx_amount_cents, fx_currency, timestamp, merchant_text,
        reference, kind, adapter_name, created_at, parse_confidence, parse_method
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      obsId, hh(), documentHash, obs.accountHint, obs.amountCents, obs.currency,
      obs.fxAmountCents || null, obs.fxCurrency || null, obs.timestamp, obs.merchantText,
      obs.reference || null, obs.kind, obs.adapterName, Date.now(),
      obs.parseConfidence ?? resolved.confidence, obs.parseMethod || resolved.method,
    );
  }
  if (resolved.observations.length > 0) {
    await pipelineService.processDocument(documentHash, { skipLlmFallback: true });
  } else if (resolved.reviewText) {
    const from = emailText.match(/^From:\s*(.+)$/im)?.[1] || '';
    const subject = emailText.match(/^Subject:\s*(.+)$/im)?.[1] || '';
    db.prepare(`
      INSERT INTO review_queue (id, household_id, document_hash, reason, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomBytes(8).toString('hex'),
      hh(),
      documentHash,
      'unparsed_alert',
      JSON.stringify({
        from,
        subject,
        text: resolved.reviewText,
        method: resolved.method,
        confidence: resolved.confidence,
      }),
      Date.now(),
    );
  }
  const inboundKind = resolved.observations.length > 0
    ? 'alert'
    : resolved.reviewText
      ? 'unparsed'
      : 'other';
  connections.recordInbound(memberId, documentHash, inboundKind, {
    method: resolved.method,
    confidence: resolved.confidence,
    status: resolved.observations.length > 0 ? 'parsed' : resolved.reviewText ? 'review' : 'other',
  });
  return {
    observationsCreated: resolved.observations.length,
    method: resolved.method,
    confidence: resolved.confidence,
  };
}

if (config.demoMode && !onboardingService.isOnboarded()) {
  logger.info('Loading demo data');
  onboardingService.loadDemoData();
}

logger.info('Services initialized', {
  adaptersRegistered: defaultRegistry.getAll().length,
  database: DATABASE_PATH,
  onboarded: onboardingService.isOnboarded(),
  demoMode: config.demoMode,
});

const app = new Hono<{ Variables: { authUser: string; householdId: string } }>();

app.use('*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, X-OE-Signature, X-OE-Recipient, X-OE-Hook-Timestamp, X-OE-Hook-Signature, ' + config.authHeaderName);
  
  const start = Date.now();
  const path = c.req.path;
  
  const publicApi =
    path === '/healthz'
    || path === '/api/ingest/email'
    || path === '/api/ingest/location'
    || path === '/api/ingest/orders'
    || path.startsWith('/api/hooks/')
    || path.startsWith('/api/auth/')
    || path.startsWith('/api/join/')
    || !path.startsWith('/api/');

  // Ingest paths sit on Access Bypass (OwnTracks/Email Worker/extension cannot send Access JWTs).
  if (publicApi) {
    c.set('householdId', DEFAULT_HOUSEHOLD_ID);
    await runWithHouseholdAsync(DEFAULT_HOUSEHOLD_ID, () => next());
    const duration = Date.now() - start;
    logger.info('Request processed', {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      duration_ms: duration,
    });
    return;
  }

  if (config.authMode === 'session') {
    if (config.accessGate) {
      const jwtUser = await validateAuth(c, {
        mode: 'header',
        headerName: config.authHeaderName,
        cfAccessTeamDomain: config.cfAccessTeamDomain,
        cfAccessAud: config.cfAccessAud,
        allowedEmails: config.allowedEmails,
      });
      if (!jwtUser) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
    }
    const sessionUser = authService.resolveSession(parseSessionCookie(c.req.header('Cookie')));
    if (!sessionUser) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const householdId = sessionUser.householdId || 'hh-none';
    c.set('authUser', sessionUser.email);
    c.set('householdId', householdId);
    await runWithHouseholdAsync(householdId, () => next());
    const duration = Date.now() - start;
    logger.info('Authenticated request', {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      duration_ms: duration,
      user: sessionUser.email,
    });
    return;
  }
  
  const user = await validateAuth(c, {
    mode: config.authMode,
    headerName: config.authHeaderName,
    cfAccessTeamDomain: config.cfAccessTeamDomain,
    cfAccessAud: config.cfAccessAud,
    allowedEmails: config.allowedEmails,
  });
  
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  c.set('authUser', user);
  c.set('householdId', DEFAULT_HOUSEHOLD_ID);
  await runWithHouseholdAsync(DEFAULT_HOUSEHOLD_ID, () => next());
  
  const duration = Date.now() - start;
  logger.info('Authenticated request', {
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    duration_ms: duration,
    user,
  });
  
  return;
});

app.get('/healthz', (c) => {
  try {
    const result = db.prepare('SELECT 1 as ok').get() as { ok: number } | undefined;
    if (!result || result.ok !== 1) {
      return c.json({ status: 'unhealthy', error: 'Database check failed' }, 503);
    }
    
    return c.json({ 
      status: 'healthy',
      timestamp: Date.now(),
      version: '0.1.0',
      database: 'ok',
    });
  } catch (error) {
    logger.error('Health check failed', { error: error instanceof Error ? error.message : String(error) });
    return c.json({ status: 'unhealthy', error: 'Database unavailable' }, 503);
  }
});

app.options('*', () => {
  return new Response(null, { status: 204 });
});

app.get('/api/health', (c) => {
  return c.json({ status: 'ok', timestamp: Date.now() });
});

app.get('/api/pipeline/graph', (c) => {
  const runId = c.req.query('runId');
  return c.json(buildPipelineGraphPayload(db, defaultRegistry, pipelineService.recorder, runId));
});

app.post('/api/pipeline/seed-synthetic', (c) => {
  if (config.authMode !== 'none') {
    return c.json({ error: 'Synthetic seed is disabled' }, 403);
  }

  const existing = db.prepare(
    "SELECT id FROM pipeline_runs WHERE filename = 'synthetic-pipeline.csv' LIMIT 1"
  ).get() as { id: string } | undefined;
  if (existing) {
    return c.json({ runId: existing.id, seeded: false });
  }

  const now = Date.now();
  db.prepare(`
    INSERT OR IGNORE INTO raw_documents (hash, filename, mime_type, uploaded_at, size_bytes)
    VALUES ('synthetic-doc-hash', 'synthetic-pipeline.csv', 'text/csv', ?, 48)
  `).run(now);
  db.prepare(`
    INSERT OR IGNORE INTO observations (
      id, document_hash, account_hint, amount_cents, currency,
      timestamp, merchant_text, kind, adapter_name, is_statement, created_at
    ) VALUES (?, 'synthetic-doc-hash', '001234567890', -450, 'SGD', ?, 'SYNTHETIC COFFEE', 'debit', 'csv-generic', 0, ?)
  `).run('synthetic-obs-1', now, now);
  db.prepare(`
    INSERT OR IGNORE INTO review_queue (id, observation_id, document_hash, reason, detail, created_at)
    VALUES ('synthetic-review-1', 'synthetic-obs-1', 'synthetic-doc-hash', 'possible_transfer', 'Synthetic review item', ?)
  `).run(now);

  const runId = pipelineService.recorder.beginRun('synthetic-pipeline.csv', 'synthetic-doc-hash');
  const stages: Array<{ name: string; input: number; output: number; adapter?: string; flagged?: number }> = [
    { name: 'ingest', input: 1, output: 1 },
    { name: 'detect-format', input: 1, output: 1, adapter: 'csv-generic' },
    { name: 'parse', input: 1, output: 2, adapter: 'csv-generic' },
    { name: 'resolve-account', input: 2, output: 2 },
    { name: 'upsert', input: 2, output: 2 },
    { name: 'match', input: 2, output: 2 },
    { name: 'reconcile', input: 0, output: 0 },
    { name: 'detect-transfers', input: 2, output: 0 },
    { name: 'enrich-merchant', input: 2, output: 1 },
    { name: 'triangulate', input: 2, output: 1 },
    { name: 'categorize', input: 2, output: 2 },
    { name: 'categorize:memory', input: 2, output: 1 },
    { name: 'categorize:rules', input: 1, output: 1 },
    { name: 'categorize:provider', input: 1, output: 1 },
    { name: 'categorize:threshold', input: 2, output: 2 },
    { name: 'location', input: 1, output: 1 },
    { name: 'calendar', input: 1, output: 1 },
    { name: 'orders', input: 1, output: 1 },
    { name: 'flag-rules', input: 2, output: 0 },
    { name: 'review-queue', input: 0, output: 0 },
  ];
  for (const stage of stages) {
    pipelineService.recorder.recordStage(runId, stage.name, '1.0.0', {
      inputCount: stage.input,
      outputCount: stage.output,
      errorCount: 0,
      flaggedCount: stage.flagged ?? 0,
      adapterName: stage.adapter,
      errors: [],
    }, 4);
  }
  pipelineService.recorder.finishRun(runId, 'success', {
    documentHash: 'synthetic-doc-hash',
    adapterName: 'csv-generic',
    observationsCreated: 2,
    transactionsCreated: 2,
  });
  return c.json({ runId, seeded: true });
});

app.get('/api/pipeline/status', (c) => {
  const documents = db
    .prepare(`
      SELECT 
        rd.hash,
        rd.filename,
        rd.uploaded_at,
        COUNT(DISTINCT o.id) as observations,
        COUNT(DISTINCT t.id) as transactions
      FROM raw_documents rd
      LEFT JOIN observations o ON o.document_hash = rd.hash
      LEFT JOIN transactions t ON json_extract(t.observation_ids, '$') LIKE '%' || o.id || '%'
      GROUP BY rd.hash
      ORDER BY rd.uploaded_at DESC
      LIMIT 50
    `)
    .all() as Array<{
      hash: string;
      filename: string;
      uploaded_at: number;
      observations: number;
      transactions: number;
    }>;

  const unparsed = db
    .prepare(`
      SELECT rd.hash, rd.filename, rd.uploaded_at
      FROM raw_documents rd
      LEFT JOIN observations o ON o.document_hash = rd.hash
      WHERE o.id IS NULL
      ORDER BY rd.uploaded_at DESC
    `)
    .all() as Array<{ hash: string; filename: string; uploaded_at: number }>;

  return c.json({
    documents,
    unparsed,
    total: documents.length,
    unparsedCount: unparsed.length,
  });
});

app.get('/api/review-queue', (c) => {
  const queue = db
    .prepare(`
      SELECT 
        rq.id,
        rq.observation_id,
        rq.reason,
        rq.detail,
        rq.created_at,
        o.merchant_text,
        o.amount_cents
      FROM review_queue rq
      JOIN observations o ON o.id = rq.observation_id
      WHERE rq.household_id = ? AND rq.resolved = 0
      ORDER BY rq.created_at DESC
    `)
    .all(hh());

  return c.json({ items: queue, count: queue.length });
});

app.get('/api/home', (c) => {
  try {
    const asOfRaw = c.req.query('asOf');
    const asOf = asOfRaw ? Number(asOfRaw) : Date.now();
    return c.json(homeService.glance(Number.isFinite(asOf) ? asOf : Date.now()));
  } catch (error) {
    logger.error('Home glance failed', { error: error instanceof Error ? error.message : String(error) });
    return c.json({ error: error instanceof Error ? error.message : 'Home glance failed' }, 500);
  }
});

app.get('/api/review', (c) => {
  try {
    return c.json(reviewService.list());
  } catch (error) {
    logger.error('Review list failed', { error: error instanceof Error ? error.message : String(error) });
    return c.json({ error: error instanceof Error ? error.message : 'Review list failed' }, 500);
  }
});

app.post('/api/review/bulk', async (c) => {
  const body = await c.req.json() as { ids?: string[]; categoryId?: string; rememberRule?: boolean };
  try {
    const result = reviewService.bulk(body.ids ?? [], {
      categoryId: body.categoryId ?? '',
      rememberRule: Boolean(body.rememberRule),
    });
    return c.json(result);
  } catch (error) {
    const status = (error as { status?: number }).status === 409 ? 409 : 400;
    return c.json({ error: error instanceof Error ? error.message : 'Bulk failed' }, status);
  }
});

app.post('/api/review/undo', async (c) => {
  const body = await c.req.json() as { undoId?: string };
  try {
    return c.json(reviewService.undo(body.undoId ?? ''));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Undo failed' }, 400);
  }
});

app.post('/api/review/:id/resolve', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json() as { categoryId?: string; skip?: boolean; rememberRule?: boolean };
  try {
    return c.json(reviewService.resolve(id, {
      categoryId: body.categoryId,
      skip: Boolean(body.skip),
      rememberRule: Boolean(body.rememberRule),
    }));
  } catch (error) {
    const status = (error as { status?: number }).status === 409 ? 409 : 400;
    return c.json({ error: error instanceof Error ? error.message : 'Resolve failed' }, status);
  }
});

app.post('/api/review/:id/enrich', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({})) as { refresh?: boolean };
  try {
    return c.json(await reviewService.enrich(id, { refresh: Boolean(body.refresh) }));
  } catch (error) {
    const status = (error as { status?: number }).status === 409 ? 409 : 400;
    return c.json({ error: error instanceof Error ? error.message : 'Enrich failed' }, status);
  }
});

app.post('/api/review/:id/payee-note', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json() as {
    payeeLabel?: string;
    project?: string;
    capitalTransfer?: boolean;
    categoryId?: string;
  };
  try {
    return c.json(reviewService.savePayeeNote(id, {
      payeeLabel: body.payeeLabel,
      project: body.project,
      capitalTransfer: Boolean(body.capitalTransfer),
      categoryId: body.categoryId,
    }));
  } catch (error) {
    const status = (error as { status?: number }).status === 409 ? 409 : 400;
    return c.json({ error: error instanceof Error ? error.message : 'nothing saved' }, status);
  }
});

app.get('/api/categories', (c) => {
  const schema = pipelineService.categoriser.schema;
  return c.json({
    categories: schema.categories.map((category) => ({
      id: category.id,
      path: category.path,
      label: category.path.join(' ▸ '),
      kind: category.kind,
    })),
  });
});

app.post('/api/dev/seed-ui', async (c) => {
  if (config.authMode !== 'none') {
    return c.json({ error: 'Synthetic seed is disabled' }, 403);
  }
  const body = await c.req.json().catch(() => ({})) as { reviews?: boolean };
  return c.json(seedUiFixtures(db, { reviews: body.reviews !== false }));
});

app.post('/api/dev/reset-onboarding', (c) => {
  if (config.authMode !== 'none') {
    return c.json({ error: 'Reset is disabled' }, 403);
  }
  householdService.resetOnboarding();
  return c.json({ ok: true });
});

function requestOrigin(c: { req: { url: string } }): string {
  return (config.publicOrigin || new URL(c.req.url).origin).replace(/\/$/, '');
}

function attachSession(c: { header: (name: string, value: string) => void }, user: { id: string; email: string; name: string | null; householdId: string | null }) {
  const session = authService.createSession(user);
  c.header('Set-Cookie', sessionCookie(session.token, session.expiresAt, config.sessionCookieSecure));
}

const signupOn = config.authMode === 'session' && config.authSignup;

app.get('/api/auth/status', (c) => {
  if (config.authMode === 'none') {
    return c.json({
      mode: 'none',
      appMode: config.appMode,
      authenticated: true,
      google: false,
      signup: false,
      user: { email: 'anonymous', householdId: DEFAULT_HOUSEHOLD_ID },
    });
  }
  if (config.authMode === 'header') {
    return c.json({
      mode: 'header',
      appMode: config.appMode,
      authenticated: true,
      google: false,
      signup: false,
    });
  }
  const sessionUser = authService.resolveSession(parseSessionCookie(c.req.header('Cookie')));
  return c.json({
    mode: 'session',
    appMode: config.appMode,
    authenticated: Boolean(sessionUser),
    google: signupOn && Boolean(config.googleClientId),
    signup: signupOn,
    user: sessionUser
      ? { email: sessionUser.email, name: sessionUser.name, householdId: sessionUser.householdId }
      : null,
  });
});

app.post('/api/auth/magic-link', async (c) => {
  if (!signupOn) return c.json({ error: 'Magic link is off' }, 404);
  const body = await c.req.json().catch(() => ({})) as { email?: string };
  try {
    const result = authService.issueMagicLink(body.email || '', requestOrigin(c), config.authMagicCapture);
    return c.json({ ok: true, ...result }, 202);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Could not send link' }, 400);
  }
});

app.get('/api/auth/magic-link/consume', (c) => {
  if (!signupOn) return c.json({ error: 'Magic link is off' }, 404);
  const token = c.req.query('token') || '';
  try {
    const user = authService.consumeMagicLink(token);
    attachSession(c, user);
    const next = c.req.query('next') || '/';
    if (c.req.header('Accept')?.includes('application/json') || config.authMagicCapture) {
      return c.json({ ok: true, user: { email: user.email, householdId: user.householdId } });
    }
    return c.redirect(next.startsWith('/') ? next : '/');
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'That link already napped.' }, 400);
  }
});

app.get('/api/auth/google/start', (c) => {
  if (!signupOn || !config.googleClientId) {
    return c.json({ error: 'Google sign-in is off' }, 404);
  }
  const state = crypto.randomBytes(16).toString('hex');
  const url = googleAuthorizeUrl({
    clientId: config.googleClientId,
    redirectUri: `${requestOrigin(c)}/api/auth/google/callback`,
    state,
  });
  return c.redirect(url);
});

app.get('/api/auth/google/callback', async (c) => {
  if (!signupOn || !config.googleClientId || !config.googleClientSecret) {
    return c.json({ error: 'Google sign-in is off' }, 404);
  }
  const code = c.req.query('code') || '';
  try {
    const profile = await exchangeGoogleCode(code, {
      clientId: config.googleClientId,
      clientSecret: config.googleClientSecret,
      redirectUri: `${requestOrigin(c)}/api/auth/google/callback`,
    });
    const user = authService.linkGoogle(profile.email, profile.sub, profile.name);
    attachSession(c, user);
    return c.redirect('/');
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Google didn't share an email" }, 400);
  }
});

app.post('/api/auth/logout', (c) => {
  authService.deleteSession(parseSessionCookie(c.req.header('Cookie')));
  c.header('Set-Cookie', clearSessionCookie(config.sessionCookieSecure));
  return c.json({ ok: true });
});

app.get('/api/join/:token', (c) => {
  try {
    const invite = authService.peekInvite(c.req.param('token'));
    return c.json({ ok: true, ...invite });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "This invite doesn't work." }, 400);
  }
});

app.post('/api/join/:token/accept', async (c) => {
  const sessionUser = authService.resolveSession(parseSessionCookie(c.req.header('Cookie')));
  if (config.authMode === 'session' && !sessionUser) {
    return c.json({ error: 'Sign in to join' }, 401);
  }
  const body = await c.req.json().catch(() => ({})) as { name?: string; consent?: boolean };
  try {
    const user = sessionUser ?? authService.upsertUser('anonymous@example.test', 'Anonymous');
    const joined = authService.acceptInvite(c.req.param('token'), user, body.name || '', Boolean(body.consent));
    if (sessionUser) attachSession(c, joined);
    return c.json({ ok: true, householdId: joined.householdId });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Join failed' }, 400);
  }
});

app.post('/api/join/:token/decline', (c) => {
  try {
    authService.declineInvite(c.req.param('token'));
    return c.json({ ok: true });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "This invite doesn't work." }, 400);
  }
});

app.post('/api/household/invite', async (c) => {
  if (config.authMode === 'none') {
    const invite = authService.createInvite(hh(), null, null);
    return c.json({
      url: `${requestOrigin(c)}/join/${invite.token}`,
      expiresAt: invite.expiresAt,
      token: config.authMagicCapture ? invite.token : undefined,
    });
  }
  if (config.authMode === 'header') {
    const member = resolveOrProvisionAccessMember(db, c.get('authUser'), {
      allowedEmails: config.allowedEmails,
      lazyCreate: config.appMode !== 'hosted',
    });
    if (!member) return c.json({ error: 'Unauthorized' }, 401);
    const body = await c.req.json().catch(() => ({})) as { email?: string };
    const invite = authService.createInvite(DEFAULT_HOUSEHOLD_ID, member.id, body.email);
    return c.json({
      url: `${requestOrigin(c)}/join/${invite.token}`,
      expiresAt: invite.expiresAt,
      token: config.authMagicCapture ? invite.token : undefined,
    });
  }
  const sessionUser = authService.resolveSession(parseSessionCookie(c.req.header('Cookie')));
  if (!sessionUser?.householdId) return c.json({ error: 'Unauthorized' }, 401);
  return runWithHouseholdAsync(sessionUser.householdId, async () => {
    const body = await c.req.json().catch(() => ({})) as { email?: string };
    const invite = authService.createInvite(sessionUser.householdId!, null, body.email);
    return c.json({
      url: `${requestOrigin(c)}/join/${invite.token}`,
      expiresAt: invite.expiresAt,
      token: config.authMagicCapture ? invite.token : undefined,
    });
  });
});

app.post('/api/household/invite/accept', async (c) => {
  const sessionUser = authService.resolveSession(parseSessionCookie(c.req.header('Cookie')));
  if (!sessionUser && config.authMode !== 'none') return c.json({ error: 'Unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({})) as { token?: string; name?: string; consent?: boolean };
  try {
    const user = sessionUser ?? authService.upsertUser('anonymous@example.test', 'Anonymous');
    const joined = authService.acceptInvite(body.token || '', user, body.name || '', Boolean(body.consent));
    if (sessionUser) attachSession(c, joined);
    return c.json({ ok: true, householdId: joined.householdId });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Join failed' }, 400);
  }
});

app.get('/api/whoami', (c) => {
  const identity = c.get('authUser');
  const householdId = c.get('householdId') || DEFAULT_HOUSEHOLD_ID;
  const member = config.authMode === 'header' && config.appMode !== 'hosted'
    ? resolveOrProvisionAccessMember(db, identity, {
      allowedEmails: config.allowedEmails,
      lazyCreate: true,
    })
    : resolveCurrentMember(db, identity, { allowedEmails: config.allowedEmails });
  const household = householdService.current();
  return c.json({
    identity,
    householdId,
    householdName: household?.name ?? null,
    onboarded: onboardingService.isOnboarded(),
    member: member
      ? { id: member.id, name: member.name, email: member.email }
      : null,
  });
});

app.get('/api/household', (c) => {
  const household = householdService.current();
  if (!household) return c.json({ error: 'No household' }, 404);
  return c.json(household);
});

app.get('/api/household/intelligence', (c) => {
  const provider = config.llmProvider;
  const fallback = 'merchant memory and rules';
  const copy = provider === 'none'
    ? 'No categoriser key on this household, so we will not guess unknown bank layouts.'
    : config.appMode === 'hosted'
      ? `Hosted categoriser. ${config.llmHouseholdDailyCap} calls/day for this household.`
      : 'Self-host: this process uses the operator key in LLM_PROVIDER.';
  return c.json({
    appMode: config.appMode,
    provider,
    dailyCap: config.llmHouseholdDailyCap,
    fallback,
    copy,
  });
});

app.get('/api/household/export', (c) => {
  return c.json(householdService.exportSnapshot());
});

app.post('/api/household/delete', async (c) => {
  const body = await c.req.json().catch(() => ({})) as { name?: string };
  try {
    householdService.deleteCurrent(body.name || '', config.appMode);
    return c.json({ ok: true });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Delete failed' }, 400);
  }
});

app.get('/api/onboarding/status', (c) => {
  return c.json(onboardingService.getStatus());
});

app.post('/api/onboarding/progress', async (c) => {
  const body = await c.req.json().catch(() => ({})) as { step?: string; payload?: Record<string, unknown> };
  if (!body.step) return c.json({ error: 'step is required' }, 400);
  onboardingService.saveProgress(body.step, body.payload ?? {});
  return c.json(onboardingService.getStatus());
});

app.post('/api/onboarding/setup', async (c) => {
  const body = await c.req.json();
  
  try {
    const result = await onboardingService.setupHousehold(body.members ?? [], body.accounts ?? []);
    return c.json({ success: true, ...result });
  } catch (error) {
    logger.error('Onboarding failed', { error: error instanceof Error ? error.message : String(error) });
    return c.json({ error: error instanceof Error ? error.message : 'Setup failed' }, 400);
  }
});

app.get('/api/accounts', (c) => {
  const accounts = db.prepare('SELECT * FROM accounts WHERE household_id = ? ORDER BY name').all(hh());
  return c.json(accounts);
});

app.post('/api/accounts', async (c) => {
  const body = await c.req.json();
  const id = crypto.randomBytes(8).toString('hex');
  
  db.prepare(`
    INSERT INTO accounts (id, household_id, name, aliases, account_group, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    hh(),
    body.name,
    JSON.stringify(body.aliases || []),
    body.group,
    Date.now()
  );

  return c.json({ id });
});

app.post('/api/import', async (c) => {
  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File;
    
    if (!file) {
      return c.json({ error: 'No file provided' }, 400);
    }

    logger.info('Importing file', { filename: file.name, size: file.size });
    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await importService.import(file.name, buffer);
    
    logger.info('Import completed', { 
      documentHash: result.documentHash,
      created: result.observationsCreated,
      duplicate: result.observationsDuplicate,
    });
    
    return c.json(result);
  } catch (error) {
    logger.error('Import failed', { error: error instanceof Error ? error.message : String(error) });
    return c.json({ error: 'Import failed' }, 500);
  }
});

registerConnectionRoutes(app, {
  db,
  connections,
  authMode: config.authMode,
});
registerOrdersIngestRoute(app, { db, connections, triangulate });
registerHookIngestRoute(app, { db, hooks, triangulate });
registerWebhookConnectionRoutes(app, { db, hooks, triangulate });

app.post('/api/ingest/location', async (c) => {
  let body: unknown = null;
  try {
    body = await c.req.json();
  } catch {
    try {
      const text = await c.req.text();
      body = text ? JSON.parse(text) as unknown : null;
    } catch {
      body = null;
    }
  }
  const result = await locationIngest.ingest(
    { authorization: c.req.header('Authorization') },
    body,
  );
  if (result.status === 401 || result.status === 404 || result.status === 429) {
    return new Response(null, { status: result.status });
  }
  if ((result.accepted ?? 0) > 0) {
    await runWithHouseholdAsync(result.householdId || 'hh-none', async () => {
      triangulate.forRecentTransactions();
    });
  }
  return c.json({ accepted: result.accepted ?? 0 }, 202);
});

app.post('/api/context/links/:id/confirm', async (c) => {
  const body = await c.req.json().catch(() => ({})) as { split?: boolean };
  try {
    triangulate.confirm(c.req.param('id'), { split: Boolean(body.split) });
    return c.json({ ok: true });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Confirm failed' }, 404);
  }
});

app.post('/api/context/links/:id/reject', async (c) => {
  triangulate.reject(c.req.param('id'));
  return c.json({ ok: true });
});

app.post('/api/ingest/email', async (c) => {
  const rawRequest = Buffer.from(await c.req.arrayBuffer());
  if (!authorizeEmailIngest({
    hmacSecret: config.emailIngestHmacSecret,
    apiKey: config.ingestApiKey,
    authMode: config.authMode,
    providedHmac: c.req.header('X-OE-Signature'),
    providedApiKey: c.req.header('X-API-Key'),
    body: rawRequest,
  })) {
    logger.warn('Unauthorized ingest attempt', { apiKey: c.req.header('X-API-Key') ? 'provided' : 'missing' });
    return new Response(null, { status: 401 });
  }

  try {
    const contentType = c.req.header('content-type') || '';
    let body: { raw_rfc822?: string; recipient?: string } | null = null;
    let isRfc822Format = false;

    if (contentType.includes('application/json')) {
      body = JSON.parse(rawRequest.toString('utf8')) as { raw_rfc822?: string; recipient?: string };
      isRfc822Format = !!body.raw_rfc822;
    }

    const requestedRecipient = c.req.header('X-OE-Recipient') || body?.recipient || null;
    const mailbox = connections.mailboxForRecipient(requestedRecipient);
    if (requestedRecipient && !mailbox) {
      return new Response(null, { status: 401 });
    }
    const memberId = mailbox?.memberId ?? null;
    return await runWithHouseholdAsync(mailbox?.householdId || DEFAULT_HOUSEHOLD_ID, async () => {

    if (isRfc822Format && body?.raw_rfc822) {
      const rawEmail = Buffer.from(body.raw_rfc822, 'base64');
      const emailText = rawEmail.toString('utf-8');
      
      const messageIdMatch = emailText.match(/^Message-ID:\s*(.+)$/im);
      const messageId = messageIdMatch ? messageIdMatch[1]!.trim() : null;

      if (messageId) {
        const existing = db
          .prepare('SELECT hash FROM raw_documents WHERE filename = ?')
          .get(`email_${messageId}`) as { hash: string } | undefined;

        if (existing) {
          logger.info('Email already ingested', { messageId });
          return c.json({ success: true, status: 'duplicate', messageId });
        }
      }

      const documentHash = crypto.createHash('sha256').update(rawEmail).digest('hex');
      const filename = messageId ? `email_${messageId}` : `email_${documentHash.substring(0, 8)}.eml`;

      const doc = await documentStore.store(filename, rawEmail);

      const existingDoc = db.prepare('SELECT hash FROM raw_documents WHERE hash = ?').get(doc.hash) as { hash: string } | undefined;

      if (!existingDoc) {
        db.prepare(`
          INSERT INTO raw_documents (hash, household_id, filename, mime_type, uploaded_at, size_bytes)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(doc.hash, hh(), doc.filename, doc.mimeType, doc.uploadedAt, doc.sizeBytes);
      }

      const gmailVerify = parseGmailForwardingVerify(emailText);
      if (gmailVerify && memberId) {
        connections.recordGmailVerify(memberId, gmailVerify);
        connections.recordInbound(memberId, documentHash, 'gmail_verify');
        return c.json({ success: true, status: 'gmail_verify', messageId, documentHash });
      }

      const orderId = await tryIngestOrder(emailText, documentHash, memberId);
      if (orderId) {
        connections.recordInbound(memberId, documentHash, 'order');
        return c.json({
          success: true,
          status: 'order',
          orderId,
          messageId,
          documentHash,
        });
      }

      const classification = await triageService.classifyEmail(emailText);
      
      if (classification.classification === 'promotional' || classification.classification === 'otp') {
        db.prepare(`
          INSERT INTO review_queue (id, household_id, document_hash, reason, detail, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          crypto.randomBytes(8).toString('hex'),
          hh(),
          documentHash,
          'non_transaction_email',
          JSON.stringify({ 
            classification: classification.classification,
            messageId,
          }),
          Date.now()
        );

        logger.info('Non-transaction email sent to review queue', { 
          classification: classification.classification, 
          messageId,
          documentHash,
        });
        return c.json({ 
          success: true, 
          status: 'review_queue',
          classification: classification.classification, 
          messageId,
          documentHash,
        });
      }

      const stored = await persistResolvedEmail(rawEmail, filename, doc.mimeType, documentHash, emailText, memberId);

      logger.info('Raw email stored and processed', {
        documentHash,
        messageId,
        observationsCreated: stored.observationsCreated,
        classification: classification.classification,
        parseMethod: stored.method,
        parseConfidence: stored.confidence,
      });

      return c.json({
        success: true,
        messageId,
        classification: classification.classification,
        documentHash,
        observationsCreated: stored.observationsCreated,
        parseMethod: stored.method,
        parseConfidence: stored.confidence,
      });
    }

    const buffer = rawRequest;
    
    logger.info('Ingesting email (legacy format)', { size: buffer.length });
    
    const documentHash = crypto.createHash('sha256').update(buffer).digest('hex');
    const doc = await documentStore.store('email-ingest.eml', buffer);
    
    const existingDoc = db.prepare('SELECT hash FROM raw_documents WHERE hash = ?').get(doc.hash) as { hash: string } | undefined;
    
    if (!existingDoc) {
      db.prepare(`
        INSERT INTO raw_documents (hash, household_id, filename, mime_type, uploaded_at, size_bytes)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(doc.hash, hh(), doc.filename, doc.mimeType, doc.uploadedAt, doc.sizeBytes);
    }
    
    const emailText = buffer.toString('utf-8');
    const gmailVerify = parseGmailForwardingVerify(emailText);
    if (gmailVerify && memberId) {
      connections.recordGmailVerify(memberId, gmailVerify);
      connections.recordInbound(memberId, documentHash, 'gmail_verify');
      return c.json({ success: true, status: 'gmail_verify', documentHash });
    }
    const orderId = await tryIngestOrder(emailText, documentHash, memberId);
    if (orderId) {
      connections.recordInbound(memberId, documentHash, 'order');
      return c.json({
        success: true,
        status: 'order',
        orderId,
        documentHash,
      });
    }
    const classification = await triageService.classifyEmail(emailText);
    
    if (classification.classification === 'promotional' || classification.classification === 'otp') {
      db.prepare(`
        INSERT INTO review_queue (id, household_id, document_hash, reason, detail, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        crypto.randomBytes(8).toString('hex'),
        hh(),
        documentHash,
        'non_transaction_email',
        JSON.stringify({ 
          classification: classification.classification,
        }),
        Date.now()
      );

      logger.info('Legacy email sent to review queue', { 
        classification: classification.classification,
        documentHash,
      });
      return c.json({
        success: true,
        status: 'review_queue',
        classification: classification.classification,
        documentHash,
      });
    }
    
    const stored = await persistResolvedEmail(buffer, doc.filename, doc.mimeType, documentHash, emailText, memberId);

    logger.info('Email ingest completed', {
      documentHash,
      observationsCreated: stored.observationsCreated,
      classification: classification.classification,
      parseMethod: stored.method,
      parseConfidence: stored.confidence,
    });

    return c.json({
      documentHash,
      observationsCreated: stored.observationsCreated,
      classification: classification.classification,
      parseMethod: stored.method,
      parseConfidence: stored.confidence,
    });
    });
  } catch (error) {
    logger.error('Email ingest failed', { error: error instanceof Error ? error.message : String(error) });
    return c.json({ error: 'Ingest failed' }, 500);
  }
});

app.get('/api/transactions', (c) => {
  const accountId = c.req.query('accountId');
  const state = c.req.query('state');
  
  let query = 'SELECT * FROM transactions WHERE household_id = ?';
  const params: unknown[] = [hh()];

  if (accountId) {
    query += ' AND account_id = ?';
    params.push(accountId);
  }

  if (state) {
    query += ' AND state = ?';
    params.push(state);
  }

  query += ' ORDER BY timestamp DESC LIMIT 100';

  const rows = db.prepare(query).all(...params) as Array<{ id: string }>;
  return c.json(rows.map((row) => ({
    ...row,
    contextSnippets: triangulate.snippetsFor(row.id),
  })));
});

app.post('/api/transactions/:id/categorize', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();

  // Guard: User-initiated category/envelope assignment only
  assertNotLLMSourced({ source: 'user' }, 'transaction category/envelope UPDATE');
  db.prepare(`
    UPDATE transactions
    SET category = ?, envelope_id = ?, updated_at = ?
    WHERE id = ? AND household_id = ?
  `).run(body.category, body.envelopeId, Date.now(), id, hh());
  pipelineService.categoriser.rememberLabel(id, body.category);

  return c.json({ success: true });
});


app.get('/api/envelopes', (c) => {
  const envelopes = db.prepare('SELECT * FROM envelopes WHERE household_id = ? ORDER BY name').all(hh());
  return c.json(envelopes);
});

app.post('/api/envelopes', async (c) => {
  const body = await c.req.json();
  const id = crypto.randomBytes(8).toString('hex');

  db.prepare(`
    INSERT INTO envelopes (id, household_id, name, owner, monthly_target_cents, color, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    hh(),
    body.name,
    body.owner,
    body.monthlyTargetCents,
    body.color,
    Date.now()
  );

  return c.json({ id });
});

app.get('/api/budget/:month', (c) => {
  const month = c.req.param('month');
  const readyToAssign = budgetService.getReadyToAssign(month);
  const allocations = budgetService.getAllocations(month);

  return c.json({ readyToAssign, allocations });
});

app.post('/api/budget/allocate', async (c) => {
  const body = await c.req.json();
  budgetService.allocate(body.envelopeId, body.month, body.amountCents);
  return c.json({ success: true });
});

app.post('/api/process-observations/:accountId', (c) => {
  const accountId = c.req.param('accountId');
  transactionService.processObservations(accountId);
  return c.json({ success: true });
});

app.get('/api/reconcile/:accountId/periods', (c) => {
  const accountId = c.req.param('accountId');
  const periods = reconciliationService.getStatementPeriods(accountId);
  return c.json(periods);
});

app.post('/api/reconcile/:accountId/periods', async (c) => {
  const accountId = c.req.param('accountId');
  const body = await c.req.json();
  
  const periodId = reconciliationService.createStatementPeriod(
    accountId,
    body.startDate,
    body.endDate,
    body.openingBalanceCents,
    body.closingBalanceCents,
    body.documentHash
  );
  
  return c.json({ id: periodId });
});

app.post('/api/reconcile/periods/:periodId', (c) => {
  const periodId = c.req.param('periodId');
  const result = reconciliationService.reconcilePeriod(periodId);
  return c.json(result);
});

app.post('/api/transactions/:id/resolve', async (c) => {
  const id = c.req.param('id');
  
  // Guard: User-initiated note clearing only
  assertNotLLMSourced({ source: 'user' }, 'transaction notes UPDATE');
  db.prepare(`
    UPDATE transactions
    SET notes = NULL, updated_at = ?
    WHERE id = ?
  `).run(Date.now(), id);
  
  return c.json({ success: true });
});

app.get('/api/transfers', (c) => {
  const pairs = transferService.getTransferPairs();
  return c.json(pairs);
});

app.post('/api/transfers/detect', (c) => {
  const result = transferService.detectAndLinkTransfers();
  return c.json({ success: true, ...result });
});

app.get('/api/push/vapid', (c) => {
  const publicKey = pushService.vapidPublicKey();
  if (!publicKey) return c.json({ error: 'Web Push is off' }, 404);
  return c.json({ publicKey });
});

app.post('/api/push/subscribe', async (c) => {
  if (!webPushEnabled()) return c.json({ error: 'Web Push is off' }, 404);
  if (!pushService.vapidPublicKey()) return c.json({ error: 'VAPID is not configured' }, 503);
  const body = await c.req.json().catch(() => ({})) as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  };
  try {
    const id = pushService.subscribe({
      endpoint: body.endpoint ?? '',
      keys: body.keys,
    });
    return c.json({ id });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Subscribe failed' }, 400);
  }
});

app.post('/api/push/unsubscribe', async (c) => {
  if (!webPushEnabled()) return c.json({ error: 'Web Push is off' }, 404);
  const body = await c.req.json().catch(() => ({})) as { endpoint?: string };
  if (!body.endpoint) return c.json({ error: 'endpoint is required' }, 400);
  pushService.unsubscribe(body.endpoint);
  return c.json({ ok: true });
});

app.get('*', async (c) => {
  const path = new URL(c.req.url).pathname;
  
  if (path.startsWith('/api/')) {
    return c.json({ error: 'Not found' }, 404);
  }
  
  try {
    const fs = await import('fs');
    const pathModule = await import('path');
    
    let filePath = pathModule.join(process.cwd(), 'dist/client', path === '/' ? 'index.html' : path);
    
    if (!fs.existsSync(filePath)) {
      filePath = pathModule.join(process.cwd(), 'dist/client/index.html');
    }
    
    const content = fs.readFileSync(filePath);
    const ext = pathModule.extname(filePath);
    
    const mimeTypes: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.webmanifest': 'application/manifest+json',
      '.woff2': 'font/woff2',
      '.woff': 'font/woff',
      '.ttf': 'font/ttf',
    };
    
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    const headers: Record<string, string> = { 'Content-Type': contentType };
    if (path === '/sw.js') {
      headers['Service-Worker-Allowed'] = '/';
      headers['Cache-Control'] = 'no-cache';
    }
    
    return new Response(content, { headers });
  } catch (error) {
    return c.json({ error: 'Not found' }, 404);
  }
});

logger.info('Starting OpenEnvelope server', { 
  port: PORT,
  database: DATABASE_PATH,
  storage: STORAGE_PATH,
});

serve({
  fetch: app.fetch,
  port: PORT,
});

logger.info('Server running', { url: `http://localhost:${PORT}` });

export default app;
