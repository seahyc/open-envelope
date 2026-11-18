// Run: node --test sidecars/order-sync/test/*.test.mjs
// Exercises the sidecar against a SYNTHETIC local shop and a mock signed-ingest receiver only.
// Needs a Playwright Chromium (npx playwright install chromium-headless-shell).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, existsSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { runOnce, sign, shopPaths } from '../sync.mjs';
import { syntheticTarget } from '../targets/synthetic.mjs';
import { Scheduler } from '../scheduler.mjs';
import { createDaemon } from '../server.mjs';

const SECRET = 'synthetic-test-secret';
const GOOD = 'synthetic-session-1';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
let shop;
let ingest;
let shopOrigin;
let ingestUrl;
let shopMode = 'normal';
const shopHits = [];
const received = [];
let tmp;

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'order-sync-'));
  shop = createServer((req, res) => {
    const cookie = req.headers.cookie || '';
    shopHits.push({ url: req.url, ua: req.headers['user-agent'] });
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<html><body>Synthetic shop</body></html>');
    }
    if (req.url.startsWith('/api/orders')) {
      if (shopMode === 'ratelimit') {
        res.writeHead(429, { 'Content-Type': 'text/plain' });
        return res.end('slow down');
      }
      if (shopMode === 'broken') {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        return res.end('oops');
      }
      if (cookie.includes('sid=blocked')) {
        res.writeHead(403, { 'Content-Type': 'text/html' });
        return res.end('<html>Please complete the captcha</html>');
      }
      if (!cookie.includes(`sid=${GOOD}`)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ is_login: false }));
      }
      // Sliding session: every authenticated call refreshes the cookie (session-only, no expiry).
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `sid=${GOOD}; Path=/; HttpOnly; SameSite=Lax` });
      return res.end(JSON.stringify({
        is_login: true,
        orders: [{
          shop: 'lazada', id: 'SYN-9', date: '2026-10-05', currency: 'SGD', total_cents: 1500, status: 'delivered',
          items: [{ name: 'Synthetic lamp', qty: 1, price_cents: 1500 }],
        }],
      }));
    }
    res.writeHead(404);
    res.end();
  });
  ingest = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const ok = req.headers['x-oe-signature'] === sign(SECRET, body);
      received.push({ path: req.url, ok, json: JSON.parse(body.toString('utf8')) });
      res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
      res.end(ok ? JSON.stringify({ matched: 1, unmatched: 0 }) : '');
    });
  });
  shopOrigin = `http://127.0.0.1:${await listen(shop)}`;
  ingestUrl = `http://127.0.0.1:${await listen(ingest)}`;
});

after(() => {
  shop.close();
  ingest.close();
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  shopMode = 'normal';
  shopHits.length = 0;
  received.length = 0;
});

const target = () => syntheticTarget(shopOrigin);
const run = (dir, reason = 'sweep') => runOnce({ chromium, target: target(), dataDir: join(tmp, dir), ingestBaseUrl: ingestUrl, secret: SECRET, reason });

function seed(dir, value, { withUa = true } = {}) {
  const paths = shopPaths(join(tmp, dir), 'synthetic');
  const cookies = [
    { name: 'sid', value, url: shopOrigin },
    { name: 'other', value: 'x', domain: 'unrelated.example', path: '/' },
  ];
  writeFileSync(paths.seed, JSON.stringify(withUa ? { userAgent: UA, cookies } : cookies));
  return paths;
}

const statuses = () => received.filter((r) => r.path === '/api/ingest/orders/sync-status').map((r) => r.json.state);

test('no session: reauth_needed is reported, nothing pushed, and the shop is not hit again until re-seeded', async () => {
  const first = await run('empty');
  assert.equal(first.state, 'reauth_needed');
  assert.deepEqual(statuses(), ['reauth_needed']);
  assert.equal(received.some((r) => r.path === '/api/ingest/orders'), false);

  shopHits.length = 0;
  const second = await run('empty');
  assert.equal(second.skipped, true);
  assert.equal(shopHits.length, 0, 'a halted shop gets no requests');
});

test('seed once: cookies imported, seed deleted, UA pinned, session (even cookie without expiry) survives restarts', async () => {
  const paths = seed('a', GOOD);
  const first = await run('a', 'charge');
  assert.equal(first.state, 'ok');
  assert.equal(existsSync(paths.seed), false, 'seed must be deleted after import');
  assert.equal(statSync(paths.state).mode & 0o777, 0o600);
  assert.equal(statSync(paths.root).mode & 0o777, 0o700);
  assert.ok(shopHits.every((hit) => hit.ua === UA), 'every request uses the seeded user agent');
  assert.ok(shopHits.some((hit) => hit.url === '/api/orders?limit=10'), 'charge-triggered fetch asks for the first small page');
  const push = received.find((r) => r.path === '/api/ingest/orders');
  assert.equal(push.ok, true);
  assert.deepEqual(push.json.orders[0], {
    shop: 'lazada', order_id: 'SYN-9', placed_at: '2026-10-05', currency: 'SGD', total_cents: 1500, status: 'delivered',
    buyer_account: null, items: [{ title: 'Synthetic lamp', qty: 1, unit_price_cents: 1500, sku: null, url: null }],
  });
  assert.deepEqual(statuses(), ['ok']);
  assert.equal(readFileSync(paths.state, 'utf8').includes('unrelated.example'), false, 'foreign cookies are dropped');

  received.length = 0;
  const second = await run('a');
  assert.equal(second.state, 'ok', 'restored from the saved session without re-seeding');
  assert.deepEqual(statuses(), ['ok']);
});

test('challenge page and 429 halt the shop (blocked), with no retry loop', async () => {
  seed('b', 'blocked');
  assert.equal((await run('b')).state, 'blocked');
  seed('c', GOOD);
  shopMode = 'ratelimit';
  assert.equal((await run('c')).state, 'blocked');
  const apiHits = shopHits.filter((hit) => hit.url.startsWith('/api/orders')).length;
  assert.equal(apiHits, 2, 'one API call per run, never retried');
  assert.equal((await run('c')).skipped, true);
  assert.deepEqual(statuses(), ['blocked', 'blocked'], 'a halted shop is not re-reported or retried');
});

test('transient errors halt only after three in a row; a new seed clears a halt', async () => {
  seed('d', GOOD);
  shopMode = 'broken';
  for (let i = 0; i < 3; i += 1) assert.equal((await run('d')).state, 'error');
  assert.equal((await run('d')).skipped, true);
  shopMode = 'normal';
  seed('d', GOOD);
  assert.equal((await run('d')).state, 'ok');
});

test('scheduler: delayed, coalesced, per-shop gap, jittered sweeps', async () => {
  let clock = 0;
  const timers = [];
  const ran = [];
  const scheduler = new Scheduler({
    shops: ['shopee', 'lazada'],
    run: async (shopName, reason) => { ran.push([shopName, reason, clock]); },
    minGapMs: 1000,
    triggerDelayMs: [100, 200],
    sweepEveryMs: 10_000,
    sweepStaggerMs: 50,
    random: () => 0.5,
    now: () => clock,
    setTimer: (fn, ms) => { const t = { fn, at: clock + ms, done: false }; timers.push(t); return t; },
    clearTimer: (t) => { t.done = true; },
  });
  const advance = async (to) => {
    for (;;) {
      const next = timers.filter((t) => !t.done && t.at <= to).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      clock = next.at;
      next.done = true;
      next.fn();
      await scheduler.idle();
    }
    clock = to;
  };
  assert.deepEqual(scheduler.trigger('nowhere'), { scheduled: false, reason: 'unknown shop' });
  assert.equal(scheduler.trigger('shopee').at, 150);
  assert.equal(scheduler.trigger('shopee').coalesced, true);
  await advance(200);
  assert.deepEqual(ran, [['shopee', 'charge', 150]]);
  assert.equal(scheduler.trigger('shopee').at, 1150, 'respects the per-shop minimum gap');
  scheduler.startSweeps();
  await advance(12_000);
  assert.deepEqual(ran.map((r) => r.slice(0, 2)), [['shopee', 'charge'], ['shopee', 'charge'], ['shopee', 'sweep'], ['lazada', 'sweep']]);
  scheduler.stop();
});

test('daemon: rejects unsigned triggers and runs a signed one', async () => {
  const dir = join(tmp, 'daemon');
  const paths = shopPaths(dir, 'synthetic');
  writeFileSync(paths.seed, JSON.stringify({ userAgent: UA, cookies: [{ name: 'sid', value: GOOD, url: shopOrigin }] }));
  const { server, scheduler } = createDaemon({
    chromium,
    targets: { synthetic: target() },
    dataDir: dir,
    ingestBaseUrl: ingestUrl,
    secret: SECRET,
    schedulerOptions: { triggerDelayMs: [0, 0], minGapMs: 0 },
    log: () => {},
  });
  const port = await listen(server);
  const body = JSON.stringify({ shop: 'synthetic', reason: 'charge' });
  const url = `http://127.0.0.1:${port}/trigger`;
  assert.equal((await fetch(url, { method: 'POST', body, headers: { 'X-OE-Signature': 'ab'.repeat(32) } })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', body, headers: { 'X-OE-Signature': sign(SECRET, body) } })).status, 202);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await scheduler.idle();
  assert.deepEqual(statuses(), ['ok']);
  scheduler.stop();
  server.close();
});
