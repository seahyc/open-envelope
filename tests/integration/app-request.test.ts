import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import type { Hono } from 'hono';

describe('App Request Integration', () => {
  let tmpDir: string;
  let db: Database.Database;
  let app: Hono;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'app-test-'));
    
    process.env.DATABASE_PATH = join(tmpDir, 'test.db');
    process.env.OBJECT_STORAGE_LOCAL_PATH = join(tmpDir, 'documents');
    process.env.LLM_PROVIDER = 'none';
    process.env.AUTH_MODE = 'none';
    
    const { initDatabase } = await import('../../src/server/db/database.js');
    db = initDatabase(process.env.DATABASE_PATH);
    
    db.prepare(`
      INSERT INTO accounts (id, name, aliases, account_group, created_at)
      VALUES ('test-account', 'Test DBS Account', '["1234", "test", "dbs"]', 'budget', ?)
    `).run(Date.now());
    
    const indexModule = await import('../../src/server/index.js');
    app = indexModule.default;
  });

  afterEach(() => {
    delete process.env.CONTEXT_LOCATION;
    if (db) db.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('POST /api/ingest/email - RFC822 format', () => {
    it('processes bank alert email through endpoint', async () => {
      const alertEmail = Buffer.from(`From: alerts@dbs.com
To: user@example.com
Subject: DBS Transaction Alert
Message-ID: <alert-123@dbs.com>
Date: Mon, 26 Oct 2026 10:00:00 +0000

Your DBS account ending in 1234 was debited SGD 45.67 at STARBUCKS on 26 Oct 2026.
`).toString('base64');

      const response = await app.request('/api/ingest/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw_rfc822: alertEmail }),
      });

      expect(response.status).toBe(200);
      const result = await response.json() as { success: boolean; documentHash: string; classification: string; observationsCreated: number; parseMethod: string };
      expect(result.success).toBe(true);
      expect(result.documentHash).toBeDefined();
      expect(result.classification).toBe('other');
      expect(result.observationsCreated).toBe(1);
      expect(result.parseMethod).toMatch(/^patterns/);
    });

    it('processes promotional email (without LLM returns other classification)', async () => {
      const promoEmail = Buffer.from(`From: marketing@bank.com
To: user@example.com
Subject: Special Offer - 50% Off!
Message-ID: <promo-456@bank.com>
Date: Mon, 26 Oct 2026 10:00:00 +0000

Amazing deals this week! Shop now!
`).toString('base64');

      const response = await app.request('/api/ingest/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw_rfc822: promoEmail }),
      });

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.success).toBe(true);
      expect(result.classification).toBe('other');
      expect(result.documentHash).toBeDefined();
    });
  });

  describe('POST /api/ingest/email - Legacy format', () => {
    it('processes bank alert in legacy format', async () => {
      const alertBuffer = Buffer.from(`From: alerts@dbs.com
To: user@example.com
Subject: DBS Transaction Alert

Your DBS account ending in 1234 was debited SGD 23.45 at GROCERY STORE on 26 Oct 2026.
`);

      const response = await app.request('/api/ingest/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: alertBuffer,
      });

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.documentHash).toBeDefined();
      expect(result.classification).toBe('other');
    });
  });

  describe('POST /api/ingest/email - raw message/rfc822 (Worker format)', () => {
    it('dedupes by Message-ID like the JSON format', async () => {
      const raw = Buffer.from(`From: alerts@dbs.com
To: user@example.com
Subject: DBS Transaction Alert
Message-ID: <raw-dedupe-1@dbs.com>
Date: Mon, 26 Oct 2026 10:00:00 +0000

Your DBS account ending in 1234 was debited SGD 12.34 at BAKERY on 26 Oct 2026.
`);
      const send = () => app.request('/api/ingest/email', {
        method: 'POST',
        headers: { 'Content-Type': 'message/rfc822' },
        body: raw,
      });
      const first = await send();
      expect(first.status).toBe(200);
      const firstBody = await first.json() as { observationsCreated: number; messageId: string };
      expect(firstBody.observationsCreated).toBe(1);
      expect(firstBody.messageId).toBe('<raw-dedupe-1@dbs.com>');

      const second = await send();
      expect(second.status).toBe(200);
      expect(await second.json()).toMatchObject({ status: 'duplicate', messageId: '<raw-dedupe-1@dbs.com>' });
    });
  });

  describe('GET /api/connections/mail-poll', () => {
    it('reports disabled when MAIL_POLL_IMAP_USER is not set', async () => {
      const response = await app.request('/api/connections/mail-poll');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ enabled: false });
    });
  });

  describe('GET /api/connections', () => {
    it('404s without a household member', async () => {
      const response = await app.request('/api/connections');
      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/ingest/location', () => {
    it('returns empty 404 when the location flag is off', async () => {
      const response = await app.request('/api/ingest/location', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ _type: 'location', lat: 1.36, lon: 103.99, tst: 1_771_000_000 }),
      });
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('');
    });

    it('returns empty 401 without Basic auth when the flag is on', async () => {
      process.env.CONTEXT_LOCATION = '1';
      const response = await app.request('/api/ingest/location', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ _type: 'location', lat: 1.36, lon: 103.99, tst: 1_771_000_000 }),
      });
      expect(response.status).toBe(401);
      expect(await response.text()).toBe('');
      delete process.env.CONTEXT_LOCATION;
    });
  });

  describe('Web Push scaffold', () => {
    it('returns 404 while WEB_PUSH is off', async () => {
      const vapid = await app.request('/api/push/vapid');
      expect(vapid.status).toBe(404);
      const subscribe = await app.request('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: 'https://push.example/sub', keys: { p256dh: 'p', auth: 'a' } }),
      });
      expect(subscribe.status).toBe(404);
    });
  });

  describe('GET /api/whoami', () => {
    it('returns tenant #1 for the Access-mapped identity', async () => {
      const response = await app.request('/api/whoami');
      expect(response.status).toBe(200);
      const body = await response.json() as { identity: string; householdId: string };
      expect(body.identity).toBe('anonymous');
      expect(body.householdId).toBe('hh-1');
    });
  });

  describe('POST /api/dev/reset-onboarding', () => {
    it('clears member-scoped Connections rows without a foreign-key error', async () => {
      const seedUi = await app.request('/api/dev/seed-ui', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviews: false }),
      });
      expect(seedUi.status).toBe(200);
      const seedConn = await app.request('/api/dev/seed-connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario: 'mixed' }),
      });
      expect(seedConn.status).toBe(200);

      const response = await app.request('/api/dev/reset-onboarding', { method: 'POST' });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });

      const status = await app.request('/api/onboarding/status');
      expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject({ onboarded: false });
      const connections = await app.request('/api/connections');
      expect(connections.status).toBe(404);
    });
  });

  describe('POST /api/import', () => {
    it('accepts file upload and returns response', async () => {
      const csvContent = Buffer.from(`Date,Description,Amount
2026-10-25,STARBUCKS,-4.50
2026-10-24,SALARY,2500.00
`);

      const formData = new FormData();
      const blob = new Blob([csvContent], { type: 'text/csv' });
      formData.append('file', blob, 'statement.csv');

      const response = await app.request('/api/import', {
        method: 'POST',
        body: formData,
      });

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.documentHash).toBeDefined();
    });
  });
});
