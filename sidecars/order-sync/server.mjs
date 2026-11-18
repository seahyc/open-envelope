#!/usr/bin/env node
// Order-sync daemon. Listens (on the private Docker network only) for signed triggers from
// OpenEnvelope when a marketplace charge lands, and sweeps a few times a day with jitter.
//
// Env:
//   OPENENVELOPE_URL            e.g. http://openenvelope:3100 (same Docker network)
//   EMAIL_INGEST_HMAC_SECRET    shared ingest secret (signs pushes, verifies triggers)
//   OPENENVELOPE_RECIPIENT      optional X-OE-Recipient for multi-household installs
//   ORDER_SYNC_SHOPS            comma list of target modules in ./targets (e.g. "shopee,lazada")
//   ORDER_SYNC_DATA_DIR         per-shop profiles and sessions (0700 volume; a secret)
//   ORDER_SYNC_PORT             default 8787
//   ORDER_SYNC_SWEEP_HOURS      default 8 (+/-25% jitter); 0 disables sweeps
//   ORDER_SYNC_MIN_GAP_MINUTES  default 20 (per shop)
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOnce, sign } from './sync.mjs';
import { Scheduler } from './scheduler.mjs';

const here = dirname(fileURLToPath(import.meta.url));

export async function loadTargets(names, env = process.env) {
  const targets = {};
  for (const name of names) {
    if (!/^[a-z0-9_-]+$/.test(name)) throw new Error(`bad target name ${name}`);
    const mod = await import(pathToFileURL(join(here, 'targets', `${name}.mjs`)).href);
    const target = mod.createTarget ? mod.createTarget(env) : null;
    if (!target) throw new Error(`target ${name} has no createTarget(env)`);
    targets[target.shop] = target;
  }
  return targets;
}

function verify(secret, body, header) {
  const got = String(header || '').replace(/^sha256=/i, '');
  if (!/^[0-9a-f]{64}$/i.test(got)) return false;
  return timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(sign(secret, body), 'hex'));
}

export function createDaemon({ chromium, targets, dataDir, ingestBaseUrl, secret, recipient = null, schedulerOptions = {}, log = console.log }) {
  const scheduler = new Scheduler({
    shops: Object.keys(targets),
    log,
    ...schedulerOptions,
    run: (shop, reason) => runOnce({ chromium, target: targets[shop], dataDir, ingestBaseUrl, secret, recipient, reason, log }),
  });
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200).end('ok');
      return;
    }
    if (req.method !== 'POST' || req.url !== '/trigger') {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (!verify(secret, body, req.headers['x-oe-signature'])) {
        res.writeHead(401).end();
        return;
      }
      let payload;
      try {
        payload = JSON.parse(body.toString('utf8'));
      } catch {
        res.writeHead(400).end();
        return;
      }
      const result = scheduler.trigger(String(payload.shop || ''), payload.reason === 'sweep' ? 'sweep' : 'charge');
      log(`trigger ${payload.shop}: ${JSON.stringify(result)}`);
      res.writeHead(result.scheduled ? 202 : 404, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
    });
  });
  return { server, scheduler };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const env = process.env;
  const names = String(env.ORDER_SYNC_SHOPS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!env.OPENENVELOPE_URL || !env.EMAIL_INGEST_HMAC_SECRET || names.length === 0) {
    console.error('OPENENVELOPE_URL, EMAIL_INGEST_HMAC_SECRET and ORDER_SYNC_SHOPS are required');
    process.exit(2);
  }
  const { chromium } = await import('playwright-core');
  const targets = await loadTargets(names, env);
  const sweepHours = Number(env.ORDER_SYNC_SWEEP_HOURS ?? 8);
  const { server, scheduler } = createDaemon({
    chromium,
    targets,
    dataDir: env.ORDER_SYNC_DATA_DIR || '/data',
    ingestBaseUrl: env.OPENENVELOPE_URL,
    secret: env.EMAIL_INGEST_HMAC_SECRET,
    recipient: env.OPENENVELOPE_RECIPIENT || null,
    schedulerOptions: {
      minGapMs: Number(env.ORDER_SYNC_MIN_GAP_MINUTES ?? 20) * 60 * 1000,
      sweepEveryMs: sweepHours * 60 * 60 * 1000,
    },
  });
  if (sweepHours > 0) scheduler.startSweeps();
  server.listen(Number(env.ORDER_SYNC_PORT || 8787), () => console.log(`order-sync listening; shops ${Object.keys(targets).join(', ')}`));
}
