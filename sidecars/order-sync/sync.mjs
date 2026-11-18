// One sync pass for one shop: a headless Chromium on a persisted per-shop profile opens the
// shop like a person would, reads the order list through the shop's own page, pushes the
// orders to OpenEnvelope's signed ingest, saves the refreshed session, and reports health
// to /api/ingest/orders/sync-status. Cookie values are never logged.
//
// Per-shop data directory (mode 0700, a secret: it holds the session):
//   profile/     Chromium user-data-dir (persistent cookies, local storage, device ids)
//   state.json   Playwright storageState saved after every good run (also keeps session cookies)
//   meta.json    { userAgent, halted: { state, detail, at } | null, errors }
//   seed.json    one-time drop-off: cookie jar to import; deleted as soon as it is read
import { createHmac } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const HALTING_STATES = new Set(['reauth_needed', 'blocked']);
const MAX_CONSECUTIVE_ERRORS = 3;

export function sign(secret, body) {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function writeSecret(path, data) {
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function shopPaths(dataDir, shop) {
  const root = join(dataDir, shop);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  return {
    root,
    profile: join(root, 'profile'),
    state: join(root, 'state.json'),
    meta: join(root, 'meta.json'),
    seed: join(root, 'seed.json'),
  };
}

export function readMeta(paths) {
  try {
    return { userAgent: null, halted: null, errors: 0, ...JSON.parse(readFileSync(paths.meta, 'utf8')) };
  } catch {
    return { userAgent: null, halted: null, errors: 0 };
  }
}

export function writeMeta(paths, meta) {
  writeSecret(paths.meta, meta);
}

/**
 * Read and delete a one-time cookie jar. Accepts a Playwright cookie array or
 * {"userAgent": "...", "cookies": [...]}; the user agent should be the one of the browser
 * the cookies came from so the session keeps a consistent fingerprint.
 */
export function takeSeed(seedPath) {
  if (!existsSync(seedPath)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(seedPath, 'utf8'));
  } finally {
    rmSync(seedPath, { force: true });
  }
  const cookies = Array.isArray(parsed) ? parsed : parsed?.cookies;
  if (!Array.isArray(cookies)) throw new Error('seed must be a cookie array or {userAgent, cookies}');
  return { cookies, userAgent: Array.isArray(parsed) ? null : (parsed.userAgent || null) };
}

function toPlaywrightCookie(cookie) {
  const out = { name: String(cookie.name), value: String(cookie.value) };
  if (cookie.url) out.url = cookie.url;
  else {
    out.domain = cookie.domain;
    out.path = cookie.path || '/';
  }
  if (typeof cookie.expires === 'number' && cookie.expires > 0) out.expires = cookie.expires;
  if (cookie.httpOnly != null) out.httpOnly = Boolean(cookie.httpOnly);
  if (cookie.secure != null) out.secure = Boolean(cookie.secure);
  if (['Strict', 'Lax', 'None'].includes(cookie.sameSite)) out.sameSite = cookie.sameSite;
  return out;
}

async function postSigned(url, secret, payload, recipient) {
  const body = JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json', 'X-OE-Signature': sign(secret, body) };
  if (recipient) headers['X-OE-Recipient'] = recipient;
  const response = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`ingest answered ${response.status}`);
  return response.json();
}

/**
 * Run one pass. Returns { state, detail, orders, skipped }.
 * state: ok | reauth_needed | blocked | error. A halted shop is skipped (no browser, no
 * request to the shop) until a new seed arrives: no retry loops against a shop that said no.
 */
export async function runOnce({
  chromium,
  target,
  dataDir,
  ingestBaseUrl,
  secret,
  recipient = null,
  headless = true,
  reason = 'sweep',
  log = () => {},
}) {
  if (!ingestBaseUrl || !secret) throw new Error('ingestBaseUrl and secret are required');
  const base = ingestBaseUrl.replace(/\/+$/, '');
  const paths = shopPaths(dataDir, target.shop);
  const meta = readMeta(paths);
  let seed = null;
  try {
    seed = takeSeed(paths.seed);
  } catch (error) {
    log(`${target.shop}: unreadable seed (${error instanceof Error ? error.message : 'error'}); deleted`);
  }
  if (seed) {
    meta.halted = null;
    meta.errors = 0;
    if (seed.userAgent) meta.userAgent = seed.userAgent;
    rmSync(paths.state, { force: true });
  }
  if (meta.halted) {
    log(`${target.shop}: halted (${meta.halted.state}); waiting for a new seed`);
    return { state: meta.halted.state, detail: 'halted until re-seeded', orders: [], skipped: true };
  }

  let context = null;
  let outcome;
  try {
    context = await chromium.launchPersistentContext(paths.profile, {
      headless,
      // A stable, non-headless user agent that matches the seeded browser; headless
      // Chromium announces itself as "HeadlessChrome", which marketplaces challenge.
      ...(meta.userAgent ? { userAgent: meta.userAgent } : {}),
      locale: 'en-SG',
      timezoneId: 'Asia/Singapore',
      viewport: { width: 1366, height: 800 },
      args: ['--disable-blink-features=AutomationControlled'],
    });
    if (seed) {
      const allowed = seed.cookies.filter((cookie) => target.cookieAllowed(cookie));
      await context.addCookies(allowed.map(toPlaywrightCookie));
      log(`${target.shop}: seeded ${allowed.length} cookie(s), ignored ${seed.cookies.length - allowed.length}; seed file deleted`);
    } else if (existsSync(paths.state)) {
      // Restores session-only cookies that a Chromium profile does not keep across restarts.
      const state = JSON.parse(readFileSync(paths.state, 'utf8'));
      if (Array.isArray(state.cookies)) await context.addCookies(state.cookies);
    }
    const page = context.pages()[0] ?? await context.newPage();
    outcome = await target.sync(page, { reason, limit: reason === 'charge' ? 10 : 30 });
    if (outcome.state === 'ok') {
      // Persist whatever the shop refreshed while we were there (sliding session cookies).
      writeSecret(paths.state, await context.storageState());
    }
  } catch (error) {
    outcome = { state: 'error', detail: error instanceof Error ? error.message.slice(0, 200) : 'error', orders: [] };
  } finally {
    await context?.close().catch(() => {});
  }

  if (outcome.state === 'ok') {
    meta.errors = 0;
    for (let i = 0; i < outcome.orders.length; i += 200) {
      const result = await postSigned(`${base}/api/ingest/orders`, secret, { orders: outcome.orders.slice(i, i + 200) }, recipient);
      log(`${target.shop}: pushed ${Math.min(200, outcome.orders.length - i)} order(s): matched ${result.matched}, unmatched ${result.unmatched}`);
    }
  } else if (HALTING_STATES.has(outcome.state)) {
    meta.halted = { state: outcome.state, detail: outcome.detail ?? null, at: Date.now() };
  } else {
    meta.errors = (meta.errors ?? 0) + 1;
    if (meta.errors >= MAX_CONSECUTIVE_ERRORS) {
      meta.halted = { state: 'error', detail: `${meta.errors} consecutive errors: ${outcome.detail ?? ''}`.slice(0, 200), at: Date.now() };
    }
  }
  writeMeta(paths, meta);
  await postSigned(`${base}/api/ingest/orders/sync-status`, secret, {
    shop: target.shop,
    state: outcome.state,
    detail: meta.halted ? `${outcome.detail ?? meta.halted.state}; paused until re-seeded` : (outcome.detail ?? null),
  }, recipient).catch((error) => log(`${target.shop}: could not report status (${error.message})`));
  log(`${target.shop}: ${outcome.state}${outcome.detail ? ` (${outcome.detail})` : ''}`);
  return { ...outcome, skipped: false };
}

/** Map an HTTP/content response from a shop to a halting state, or null when it looks normal. */
export function classifyBlock({ status, contentType = '', text = '' }) {
  if (status === 429) return { state: 'blocked', detail: 'rate limited (429)' };
  if (/captcha|verify you are human|unusual traffic|\/verify\/traffic|punish|x5sec/i.test(text)) {
    return { state: 'blocked', detail: 'captcha/challenge' };
  }
  if (status === 403 && !contentType.includes('json')) return { state: 'blocked', detail: 'forbidden (403)' };
  return null;
}
