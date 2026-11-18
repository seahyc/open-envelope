// Run: node --test sidecars/order-sync/test/
// Exercises the sidecar against a SYNTHETIC local shop and a mock signed-ingest receiver.
// Needs a Playwright Chromium (npx playwright install chromium).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { runOnce, sign, syntheticTarget } from '../sync.mjs';

const SECRET = 'synthetic-test-secret';
const GOOD = 'synthetic-session-1';
let shop;
let ingest;
let shopOrigin;
let ingestUrl;
const received = [];
let tmp;

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'order-sync-'));
  shop = createServer((req, res) => {
    const cookie = req.headers.cookie || '';
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<html><body>Synthetic shop</body></html>');
    }
    if (req.url === '/api/orders') {
      if (cookie.includes('sid=blocked')) {
        res.writeHead(403, { 'Content-Type': 'text/html' });
        return res.end('<html>Please complete the captcha</html>');
      }
      if (!cookie.includes(`sid=${GOOD}`)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ is_login: false }));
      }
      // Refresh-by-use: the shop rotates the session expiry on every authenticated call.
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': `sid=${GOOD}; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax`,
      });
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
      res.end(ok ? JSON.stringify({ inserted: 1 }) : '');
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

const run = (profile, jar) => runOnce({
  chromium,
  target: syntheticTarget(shopOrigin),
  profileDir: join(tmp, profile),
  cookieJarPath: jar ?? null,
  ingestBaseUrl: ingestUrl,
  secret: SECRET,
});

function jar(name, value) {
  const path = join(tmp, `${name}.json`);
  const expires = Math.floor(Date.now() / 1000) + 3600;
  writeFileSync(path, JSON.stringify([
    { name: 'sid', value, url: shopOrigin, expires },
    { name: 'other', value: 'x', domain: 'unrelated.example', path: '/', expires },
  ]));
  return path;
}

test('without a session the sync reports reauth_needed and pushes no orders', async () => {
  received.length = 0;
  const outcome = await run('profile-empty');
  assert.equal(outcome.state, 'reauth_needed');
  assert.deepEqual(received.map((r) => [r.path, r.ok, r.json.state]), [['/api/ingest/orders/sync-status', true, 'reauth_needed']]);
});

test('a one-time cookie jar seeds the profile, is deleted, and the session persists for later runs', async () => {
  received.length = 0;
  const path = jar('seed', GOOD);
  const first = await run('profile-a', path);
  assert.equal(first.state, 'ok');
  assert.equal(existsSync(path), false, 'cookie jar must be deleted after import');
  assert.equal(received[0].path, '/api/ingest/orders');
  assert.equal(received[0].ok, true);
  assert.deepEqual(received[0].json.orders[0], {
    shop: 'lazada', order_id: 'SYN-9', placed_at: '2026-10-05', currency: 'SGD', total_cents: 1500, status: 'delivered',
    buyer_account: null, items: [{ title: 'Synthetic lamp', qty: 1, unit_price_cents: 1500, sku: null, url: null }],
  });
  assert.equal(received[1].json.state, 'ok');

  received.length = 0;
  const second = await run('profile-a');
  assert.equal(second.state, 'ok', 'persisted profile keeps the session without re-seeding');
  assert.equal(received[0].path, '/api/ingest/orders');
});

test('a challenge page degrades to blocked, not silence', async () => {
  received.length = 0;
  const outcome = await run('profile-b', jar('blocked', 'blocked'));
  assert.equal(outcome.state, 'blocked');
  assert.deepEqual(received.map((r) => r.json.state), ['blocked']);
});
