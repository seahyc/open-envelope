#!/usr/bin/env node
// Order-sync sidecar SPIKE: drive a headless Chromium with a persisted profile, call a
// shop's own order API from inside its page (same-origin, the session cookies ride along),
// and push the orders to OpenEnvelope's signed ingest. Health is reported per shop to
// /api/ingest/orders/sync-status so an expired session shows up as "re-auth needed".
//
// Only the synthetic target ships here. Real shop targets are deliberately not included
// until they can be exercised against a live session (see README.md).
//
// Session seeding: a one-time cookie jar (Playwright cookie JSON) is imported into the
// persistent profile and then deleted. Cookie values are never logged.
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function sign(secret, body) {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/** Import a one-time cookie jar into the context, keep only the target's cookies, then delete the jar. */
export async function seedCookies(context, jarPath, target, log = () => {}) {
  if (!jarPath || !existsSync(jarPath)) return 0;
  let cookies;
  try {
    cookies = JSON.parse(readFileSync(jarPath, 'utf8'));
  } finally {
    rmSync(jarPath, { force: true });
  }
  if (!Array.isArray(cookies)) throw new Error('cookie jar must be a JSON array');
  const allowed = cookies.filter((cookie) => target.cookieAllowed(cookie));
  await context.addCookies(allowed.map((cookie) => {
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
  }));
  log(`seeded ${allowed.length} cookie(s) for ${target.shop}; ${cookies.length - allowed.length} ignored; jar deleted`);
  return allowed.length;
}

async function postSigned(url, secret, payload, recipient) {
  const body = JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json', 'X-OE-Signature': sign(secret, body) };
  if (recipient) headers['X-OE-Recipient'] = recipient;
  const response = await fetch(url, { method: 'POST', headers, body });
  if (!response.ok) throw new Error(`ingest answered ${response.status}`);
  return response.json();
}

/**
 * One sync pass for one target. Returns { state, orders, detail }.
 * state: ok | reauth_needed | blocked | error (mirrors the app's order_sync_state).
 */
export async function runOnce({
  chromium,
  target,
  profileDir,
  cookieJarPath = null,
  ingestBaseUrl,
  secret,
  recipient = null,
  headless = true,
  log = () => {},
}) {
  if (!ingestBaseUrl || !secret) throw new Error('ingestBaseUrl and secret are required');
  const base = ingestBaseUrl.replace(/\/+$/, '');
  let context = null;
  let outcome;
  try {
    context = await chromium.launchPersistentContext(profileDir, { headless });
    await seedCookies(context, cookieJarPath, target, log);
    const page = context.pages()[0] ?? await context.newPage();
    const landing = await page.goto(target.landingUrl, { waitUntil: 'domcontentloaded' });
    if (target.isLoginUrl(page.url())) {
      outcome = { state: 'reauth_needed', detail: 'redirected to login', orders: [] };
    } else {
      const raw = await page.evaluate(target.fetchInPage, target.fetchArgs);
      outcome = target.classify(raw, { landingStatus: landing?.status() ?? 0 });
    }
  } catch (error) {
    outcome = { state: 'error', detail: error instanceof Error ? error.message.slice(0, 200) : 'error', orders: [] };
  } finally {
    await context?.close();
  }

  if (outcome.state === 'ok' && outcome.orders.length > 0) {
    for (let i = 0; i < outcome.orders.length; i += 200) {
      const result = await postSigned(`${base}/api/ingest/orders`, secret, { orders: outcome.orders.slice(i, i + 200) }, recipient);
      log(`pushed ${Math.min(200, outcome.orders.length - i)} order(s): ${JSON.stringify(result)}`);
    }
  }
  await postSigned(`${base}/api/ingest/orders/sync-status`, secret, {
    shop: target.shop,
    state: outcome.state,
    detail: outcome.detail ?? null,
  }, recipient);
  log(`${target.shop}: ${outcome.state}${outcome.detail ? ` (${outcome.detail})` : ''}`);
  return outcome;
}

/**
 * Synthetic target for tests and local demos: a fake shop whose /api/orders requires a
 * session cookie and answers {"is_login": false} without one, or a captcha page when blocked.
 */
export function syntheticTarget(origin) {
  const host = new URL(origin).hostname;
  return {
    shop: 'synthetic',
    landingUrl: `${origin}/`,
    fetchArgs: { path: '/api/orders' },
    cookieAllowed: (cookie) => {
      const domain = cookie.url ? new URL(cookie.url).hostname : String(cookie.domain || '').replace(/^\./, '');
      return domain === host;
    },
    isLoginUrl: (url) => new URL(url).pathname.startsWith('/login'),
    // Runs inside the page: same-origin fetch, cookies included by the browser.
    fetchInPage: async ({ path }) => {
      const response = await fetch(path, { credentials: 'include' });
      return { status: response.status, contentType: response.headers.get('content-type') || '', text: await response.text() };
    },
    classify: (raw) => {
      if (!raw.contentType.includes('json')) {
        return /captcha|verify you are human/i.test(raw.text)
          ? { state: 'blocked', detail: 'captcha/challenge page', orders: [] }
          : { state: 'error', detail: `unexpected ${raw.status} ${raw.contentType}`, orders: [] };
      }
      const data = JSON.parse(raw.text);
      if (data.is_login === false) return { state: 'reauth_needed', detail: 'session expired', orders: [] };
      return {
        state: 'ok',
        orders: (data.orders ?? []).map((order) => ({
          shop: order.shop,
          order_id: order.id,
          placed_at: order.date,
          currency: order.currency,
          total_cents: order.total_cents,
          status: order.status,
          buyer_account: null,
          items: order.items.map((item) => ({ title: item.name, qty: item.qty, unit_price_cents: item.price_cents, sku: null, url: null })),
        })),
      };
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { chromium } = await import('playwright-core');
  const origin = process.env.ORDER_SYNC_SYNTHETIC_ORIGIN;
  if (!origin) {
    console.error('Only the synthetic target exists in this spike: set ORDER_SYNC_SYNTHETIC_ORIGIN.');
    process.exit(2);
  }
  const outcome = await runOnce({
    chromium,
    target: syntheticTarget(origin),
    profileDir: process.env.ORDER_SYNC_PROFILE_DIR || './profile',
    cookieJarPath: process.env.ORDER_SYNC_COOKIE_JAR || null,
    ingestBaseUrl: process.env.OPENENVELOPE_URL,
    secret: process.env.EMAIL_INGEST_HMAC_SECRET,
    recipient: process.env.OPENENVELOPE_RECIPIENT || null,
    log: (line) => console.log(line),
  });
  process.exit(outcome.state === 'ok' ? 0 : 3);
}
