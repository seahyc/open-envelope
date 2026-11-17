import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/server/db/migrations.js';
import { CalendarPollService } from '../../src/server/services/context/calendar-poll.js';
import { LocationIngestService } from '../../src/server/services/context/location-ingest.js';
import {
  ConnectionsService,
  deriveStatus,
  seedConnectionsScenario,
} from '../../src/server/services/context/connections-service.js';
import { parseGmailForwardingVerify } from '../../src/server/services/context/gmail-verify.js';
import { GMAIL_RECEIPT_FILTER } from '../../src/server/services/context/gmail-filter.js';
import { authorizeEmailIngest, emailHmacHex } from '../../src/server/lib/email-hmac.js';
import { OrdersIngestService } from '../../src/server/services/context/orders-ingest.js';
import { extractOrdersFromHtml, pageIsOrderHistory } from '../../extension/extract.js';
import { purgeOldInboundMail, INBOUND_MAIL_TTL_MS } from '../../src/server/services/context/retention.js';
import { routeFromPath, pathFromRoute } from '../../src/client/routes';

describe('Connections', () => {
  let db: Database.Database;
  let connections: ConnectionsService;
  const previousDomain = process.env.EMAIL_INGEST_DOMAIN;
  const previousOrders = process.env.CONTEXT_ORDERS;

  beforeEach(() => {
    process.env.EMAIL_INGEST_DOMAIN = 'ingest.example.test';
    process.env.CONTEXT_ORDERS = '1';
    db = new Database(':memory:');
    runMigrations(db, { quiet: true });
    db.prepare(
      "INSERT INTO household_members (id, name, email, created_at) VALUES ('mem-alex', 'Alex', 'alex@example.com', ?)"
    ).run(Date.now());
    const calendar = new CalendarPollService(db, (async () => new Response('BEGIN:VCALENDAR\nEND:VCALENDAR', {
      status: 200,
      url: 'https://calendar.google.com/calendar/ical/secret/basic.ics',
    })) as typeof fetch);
    connections = new ConnectionsService(db, calendar, new LocationIngestService(db), () => Date.UTC(2026, 9, 14));
  });

  afterEach(() => {
    if (previousDomain === undefined) delete process.env.EMAIL_INGEST_DOMAIN;
    else process.env.EMAIL_INGEST_DOMAIN = previousDomain;
    if (previousOrders === undefined) delete process.env.CONTEXT_ORDERS;
    else process.env.CONTEXT_ORDERS = previousOrders;
    db.close();
  });

  it('regenerates an unguessable mailbox and matches plus-address tags', () => {
    const member = connections.snapshot('alex', 'https://app.example.test')!.member;
    const first = connections.enableMailbox(member);
    expect(first.localPart).toMatch(/^alex-[a-f0-9]{16}$/);
    const second = connections.regenerateMailbox(member);
    expect(second.localPart).not.toBe(first.localPart);
    expect(connections.mailboxForRecipient(first.address)).toBeNull();
    expect(connections.mailboxForRecipient(second.address)?.memberId).toBe('mem-alex');
    expect(connections.mailboxForRecipient(`oe+${second.localPart}@example.com`)?.memberId).toBe('mem-alex');
    const email = connections.snapshot('alex', 'http://localhost')!.sources.find((s) => s.kind === 'email');
    expect(email?.setup.emailPhase).toBe('waiting_forwarding_confirm');
    expect(email?.flagOn).toBe(true);
  });

  it('starts unset and mints per-source credentials for the Access member', () => {
    const snap = connections.snapshot('alex', 'https://app.example.test');
    expect(snap?.member.name).toBe('Alex');
    expect(snap?.sources.every((s) => s.status === 'unset')).toBe(true);
    const box = connections.enableMailbox(snap!.member);
    expect(box.address).toMatch(/alex-[a-f0-9]+@ingest\.example\.test/);
    const loc = connections.mintLocation(snap!.member);
    expect(loc.deviceId).toBe('alex-phone');
    expect(loc.secret.length).toBeGreaterThan(8);
    const ext = connections.mintExtension(snap!.member);
    expect(connections.verifyExtensionToken(ext.token)).toBe('mem-alex');
    expect(connections.verifyExtensionToken('ext.nope.nope')).toBeNull();
  });

  it('records a Gmail forwarding confirmation on the mailbox card', () => {
    const member = connections.snapshot('anonymous', 'http://localhost')!.member;
    connections.enableMailbox(member);
    const raw = readFileSync(join(process.cwd(), 'fixtures/context/gmail-forwarding.eml'), 'utf8');
    const parsed = parseGmailForwardingVerify(raw);
    expect(parsed).toEqual({
      code: '84729103',
      link: 'https://mail.google.com/mail/#setup/forwardingconfirm/abc123',
    });
    connections.recordGmailVerify(member.id, parsed!);
    const email = connections.snapshot('alex', 'http://localhost')!.sources.find((s) => s.kind === 'email');
    expect(email?.setup.gmailVerifyCode).toBe('84729103');
    expect(email?.status).toBe('waiting');
    expect(email?.setup.emailPhase).toBe('waiting_test_alert');
  });

  it('seeds mixed statuses for screenshots', () => {
    seedConnectionsScenario(db, 'mem-alex', 'mixed', Date.UTC(2026, 9, 14));
    const statuses = connections.snapshot('alex', 'http://localhost')!.sources.map((s) => `${s.kind}:${s.status}`);
    expect(statuses).toEqual([
      'email:waiting',
      'calendar:healthy',
      'location:stale',
      'extension:error',
      'webhook:unset',
    ]);
  });

  it('disconnects and deletes only that member source', () => {
    const member = connections.snapshot('alex', 'http://localhost')!.member;
    connections.enableMailbox(member);
    connections.recordInbound(member.id, 'hash-1', 'order');
    connections.disconnect(member.id, 'email', true);
    expect(connections.snapshot('alex', 'http://localhost')!.sources[0]?.status).toBe('unset');
    expect(db.prepare('SELECT COUNT(*) as n FROM inbound_mail').get()).toEqual({ n: 0 });
  });
});

describe('email HMAC and Gmail filter', () => {
  it('accepts a matching HMAC and rejects anything else with no detail', () => {
    const body = Buffer.from('hello');
    const secret = 's3cret';
    const sig = emailHmacHex(secret, body);
    expect(authorizeEmailIngest({
      hmacSecret: secret,
      authMode: 'header',
      providedHmac: sig,
      body,
    })).toBe(true);
    expect(authorizeEmailIngest({
      hmacSecret: secret,
      authMode: 'header',
      providedHmac: 'ab'.repeat(32),
      body,
    })).toBe(false);
  });

  it('covers common Singapore bank alert sender domains', () => {
    expect(GMAIL_RECEIPT_FILTER).toContain('notify.ocbc.com');
    expect(GMAIL_RECEIPT_FILTER).toContain('uob.com.sg');
    expect(GMAIL_RECEIPT_FILTER).toContain('trustbank.sg');
    expect(GMAIL_RECEIPT_FILTER).toContain('gxs.com.sg');
    expect(GMAIL_RECEIPT_FILTER).toContain('citibank.com.sg');
    expect(GMAIL_RECEIPT_FILTER).toContain('hsbc.com.sg');
    expect(GMAIL_RECEIPT_FILTER).toContain('maybank.com');
    expect(GMAIL_RECEIPT_FILTER).toContain('sc.com');
  });
});

describe('calendar validate and orders ingest', () => {
  it('rejects a non-Google URL without fetching', async () => {
    const db = new Database(':memory:');
    runMigrations(db, { quiet: true });
    db.prepare(
      "INSERT INTO household_members (id, name, email, created_at) VALUES ('mem-alex', 'Alex', 'a@example.com', 1)"
    ).run();
    let called = 0;
    const calendar = new CalendarPollService(db, (async () => {
      called += 1;
      return new Response('nope');
    }) as typeof fetch);
    const result = await calendar.validateAndSet('mem-alex', 'https://example.com/cal.ics');
    expect(result.ok).toBe(false);
    expect(called).toBe(0);
    db.close();
  });

  it('ingests extension orders when the orders flag is on', () => {
    process.env.CONTEXT_ORDERS = '1';
    const db = new Database(':memory:');
    runMigrations(db, { quiet: true });
    db.prepare(
      "INSERT INTO household_members (id, name, email, created_at) VALUES ('mem-alex', 'Alex', 'a@example.com', 1)"
    ).run();
    const ingest = new OrdersIngestService(db);
    const result = ingest.ingest('mem-alex', [{
      merchant: 'Shopee',
      order_id: 'SP240101ABCDEF',
      total_cents: 1290,
      items: [{ name: 'AirPods case' }],
    }]);
    expect(result.accepted).toBe(1);
    expect(db.prepare('SELECT source, merchant FROM orders').get()).toEqual({ source: 'extension', merchant: 'shopee' });
    db.close();
  });
});

describe('extension extract and mail retention', () => {
  it('pulls Shopee order id and items from a fixture page on user gesture', () => {
    const html = readFileSync(join(process.cwd(), 'fixtures/context/shopee-orders.html'), 'utf8');
    expect(pageIsOrderHistory('https://shopee.sg/user/purchase', html)).toBe(true);
    const orders = extractOrdersFromHtml(html, 'https://shopee.sg/user/purchase');
    expect(orders[0]?.order_id).toBe('SP240101ABCDEF');
    expect(orders[0]?.items.map((i) => i.name)).toContain('AirPods case');
  });

  it('purges inbound mail after 30 days', () => {
    const db = new Database(':memory:');
    runMigrations(db, { quiet: true });
    const now = Date.UTC(2026, 9, 14);
    db.prepare(
      "INSERT INTO household_members (id, name, email, created_at) VALUES ('mem-alex', 'Alex', 'a@example.com', ?)"
    ).run(now);
    db.prepare(
      'INSERT INTO inbound_mail (id, member_id, document_hash, kind, received_at) VALUES (?,?,?,?,?)',
    ).run('old', 'mem-alex', 'hash-old', 'order', now - INBOUND_MAIL_TTL_MS - 1000);
    db.prepare(
      'INSERT INTO inbound_mail (id, member_id, document_hash, kind, received_at) VALUES (?,?,?,?,?)',
    ).run('new', 'mem-alex', 'hash-new', 'order', now);
    expect(purgeOldInboundMail(db, undefined, now)).toBe(1);
    expect(db.prepare('SELECT id FROM inbound_mail').all()).toEqual([{ id: 'new' }]);
    db.close();
  });
});

describe('connections route', () => {
  it('maps /settings/connections', () => {
    expect(routeFromPath('/settings/connections')).toBe('connections');
    expect(pathFromRoute('connections')).toBe('/settings/connections');
  });
});

describe('status helper', () => {
  const now = 1_000_000;
  it('covers unset waiting healthy stale error', () => {
    expect(deriveStatus(false, null, null, now)).toBe('unset');
    expect(deriveStatus(true, null, null, now)).toBe('waiting');
    expect(deriveStatus(true, now - 60_000, null, now)).toBe('healthy');
    expect(deriveStatus(true, now - 8 * 24 * 60 * 60 * 1000, null, now)).toBe('stale');
    expect(deriveStatus(true, now, 'boom', now)).toBe('error');
  });
});
