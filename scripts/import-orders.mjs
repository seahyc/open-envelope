#!/usr/bin/env node
// Import marketplace orders (JSONL, one order per line) into OpenEnvelope.
//
//   EMAIL_INGEST_HMAC_SECRET=... OPENENVELOPE_URL=https://budget.example.com \
//     node scripts/import-orders.mjs orders/lazada.jsonl orders/shopee.jsonl
//   cat orders/*.jsonl | node scripts/import-orders.mjs -        # read stdin
//
// Line contract:
//   {"shop":"lazada|shopee|amazon","order_id":"...","placed_at":"YYYY-MM-DD"|null,"currency":"SGD",
//    "total_cents":12345,"status":"...","buyer_account":"...",
//    "items":[{"title":"...","qty":1,"unit_price_cents":1234|null,"sku":null,"url":null}]}
//
// Each batch (200 orders) is POSTed to $OPENENVELOPE_URL/api/ingest/orders with
// X-OE-Signature = hex HMAC-SHA256(raw body, EMAIL_INGEST_HMAC_SECRET). Optional
// OPENENVELOPE_RECIPIENT is sent as X-OE-Recipient (multi-household installs).
// Re-running is safe: orders upsert by (shop, order_id). The secret is never printed.
// Flags: --dry-run (validate and count only), --batch-size=N.
import { createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const batchArg = args.find((arg) => arg.startsWith('--batch-size='));
const batchSize = Math.max(1, Math.min(1000, Number(batchArg?.split('=')[1] ?? 200) || 200));
const files = args.filter((arg) => !arg.startsWith('--'));

function fail(message) {
  console.error(`import-orders: ${message}`);
  process.exit(1);
}

if (files.length === 0) fail('usage: import-orders.mjs [--dry-run] [--batch-size=200] <file.jsonl|-> [...]');
const baseUrl = (process.env.OPENENVELOPE_URL || '').replace(/\/+$/, '');
const secret = process.env.EMAIL_INGEST_HMAC_SECRET || '';
if (!dryRun && !baseUrl) fail('OPENENVELOPE_URL is not set');
if (!dryRun && !secret) fail('EMAIL_INGEST_HMAC_SECRET is not set');

const SHOPS = new Set(['lazada', 'shopee', 'amazon']);

function validate(order) {
  if (!order || typeof order !== 'object' || Array.isArray(order)) return 'not an object';
  if (!SHOPS.has(String(order.shop || '').toLowerCase())) return 'unknown shop';
  if (!order.order_id) return 'missing order_id';
  if (order.placed_at != null && !/^\d{4}-\d{2}-\d{2}/.test(String(order.placed_at))) return 'bad placed_at';
  if (order.total_cents != null && !Number.isInteger(order.total_cents)) return 'total_cents not an integer';
  if (order.items != null && !Array.isArray(order.items)) return 'items not an array';
  return null;
}

async function* readOrders(file) {
  const input = file === '-' ? process.stdin : createReadStream(file, { encoding: 'utf8' });
  const rl = createInterface({ input, crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo += 1;
    if (!line.trim()) continue;
    let order;
    try {
      order = JSON.parse(line);
    } catch {
      yield { error: 'invalid JSON', where: `${file}:${lineNo}` };
      continue;
    }
    const problem = validate(order);
    if (problem) yield { error: problem, where: `${file}:${lineNo}` };
    else yield { order: { ...order, shop: String(order.shop).toLowerCase() } };
  }
}

const totals = { sent: 0, skipped: 0, inserted: 0, updated: 0, matched: 0, unmatched: 0, rejected: 0 };
const perShop = {};

async function send(batch) {
  const body = JSON.stringify({ orders: batch });
  if (dryRun) {
    totals.sent += batch.length;
    return;
  }
  const signature = createHmac('sha256', secret).update(body).digest('hex');
  const headers = { 'Content-Type': 'application/json', 'X-OE-Signature': signature };
  if (process.env.OPENENVELOPE_RECIPIENT) headers['X-OE-Recipient'] = process.env.OPENENVELOPE_RECIPIENT;
  let response;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      response = await fetch(`${baseUrl}/api/ingest/orders`, { method: 'POST', headers, body });
      if (response.status < 500) break;
    } catch (error) {
      if (attempt === 3) fail(`network error: ${error instanceof Error ? error.message : String(error)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
  }
  if (!response || !response.ok) {
    fail(`server answered ${response?.status ?? 'nothing'}${response?.status === 401 ? ' (signature rejected: check the secret/recipient)' : ''}`);
  }
  const result = await response.json();
  totals.sent += batch.length;
  for (const key of ['inserted', 'updated', 'matched', 'unmatched', 'rejected']) totals[key] += Number(result[key] || 0);
  console.log(`batch of ${batch.length}: inserted ${result.inserted}, updated ${result.updated}, matched ${result.matched}, unmatched ${result.unmatched}, rejected ${result.rejected}`);
}

let batch = [];
for (const file of files) {
  for await (const row of readOrders(file)) {
    if (row.error) {
      totals.skipped += 1;
      console.warn(`skip ${row.where}: ${row.error}`);
      continue;
    }
    perShop[row.order.shop] = (perShop[row.order.shop] ?? 0) + 1;
    batch.push(row.order);
    if (batch.length >= batchSize) {
      await send(batch);
      batch = [];
    }
  }
}
if (batch.length) await send(batch);

console.log(`${dryRun ? 'dry run: ' : ''}orders by shop ${JSON.stringify(perShop)}`);
console.log(JSON.stringify(totals));
