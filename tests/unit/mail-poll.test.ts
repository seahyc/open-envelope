import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../../src/server/db/migrations.js';
import {
  DEFAULT_GMAIL_ALERT_QUERY,
  MailPollService,
  loadMailPollConfig,
  type MailPollConfig,
  type MailSession,
} from '../../src/server/services/context/mail-poll.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 18, 8, 0, 0);

function config(overrides: Partial<MailPollConfig> = {}): MailPollConfig {
  return {
    host: 'imap.example.com',
    port: 993,
    secure: true,
    user: 'me@example.com',
    password: 'pw',
    mailbox: 'auto',
    gmailQuery: 'from:bank.example',
    senders: ['bank.example'],
    intervalMs: 300_000,
    lookbackDays: 3,
    maxPerRun: 25,
    recipient: null,
    ...overrides,
  };
}

class FakeMailbox {
  messages = new Map<number, string>();
  uidValidity = '1';
  gmailSearch = true;
  searches: Array<{ since: Date; gmailQuery?: string; senders?: string[] }> = [];
  connects = 0;
  closes = 0;
  failConnect: Error | null = null;

  connector = async (): Promise<MailSession> => {
    this.connects += 1;
    if (this.failConnect) throw this.failConnect;
    return {
      mailbox: '[Gmail]/All Mail',
      uidValidity: this.uidValidity,
      gmailSearch: this.gmailSearch,
      search: async (criteria) => {
        this.searches.push(criteria);
        return [...this.messages.keys()];
      },
      fetchSource: async (uid) => {
        const text = this.messages.get(uid);
        return text ? Buffer.from(text) : null;
      },
      close: async () => {
        this.closes += 1;
      },
    };
  };
}

describe('loadMailPollConfig', () => {
  it('is disabled without MAIL_POLL_IMAP_USER', () => {
    expect(loadMailPollConfig({})).toBeNull();
  });

  it('defaults Gmail host, All Mail, the alert query and strips app-password spaces', () => {
    const cfg = loadMailPollConfig({
      MAIL_POLL_IMAP_USER: 'someone@gmail.com',
      MAIL_POLL_IMAP_PASSWORD: 'abcd efgh ijkl mnop',
      MAIL_POLL_RECIPIENT: 'me-123@ingest.example.com',
    });
    expect(cfg).toMatchObject({
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      password: 'abcdefghijklmnop',
      mailbox: 'auto',
      gmailQuery: DEFAULT_GMAIL_ALERT_QUERY,
      intervalMs: 300_000,
      lookbackDays: 3,
      recipient: 'me-123@ingest.example.com',
    });
  });

  it('requires a host for non-Gmail accounts and reads the password from a file', () => {
    expect(loadMailPollConfig({ MAIL_POLL_IMAP_USER: 'me@example.com', MAIL_POLL_IMAP_PASSWORD: 'x' })).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), 'mail-poll-'));
    writeFileSync(join(dir, 'pw'), 'from-file\n');
    const cfg = loadMailPollConfig({
      MAIL_POLL_IMAP_USER: 'me@example.com',
      MAIL_POLL_IMAP_HOST: 'imap.example.com',
      MAIL_POLL_IMAP_PASSWORD_FILE: join(dir, 'pw'),
      MAIL_POLL_FROM: 'bank-a.example, bank-b.example',
      MAIL_POLL_INTERVAL_SECONDS: '5',
    });
    expect(cfg?.password).toBe('from-file');
    expect(cfg?.senders).toEqual(['bank-a.example', 'bank-b.example']);
    // Interval is clamped to the 60s minimum (falls back to the default).
    expect(cfg?.intervalMs).toBe(300_000);
  });
});

describe('MailPollService', () => {
  let db: Database.Database;
  let box: FakeMailbox;
  let ingested: string[];
  let now: number;
  let ingestImpl: (raw: Buffer) => Promise<{ status: string }>;

  const service = (cfg = config(), preflight?: () => string | null) =>
    new MailPollService(db, cfg, (raw) => ingestImpl(raw), box.connector, { now: () => now, preflight });

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, { quiet: true });
    box = new FakeMailbox();
    ingested = [];
    now = NOW;
    ingestImpl = async (raw) => {
      const text = raw.toString();
      if (ingested.includes(text)) return { status: 'duplicate' };
      ingested.push(text);
      return { status: 'processed' };
    };
  });

  it('ingests new matches once, then skips them on later polls', async () => {
    box.messages.set(10, 'alert-10');
    box.messages.set(11, 'alert-11');
    const poller = service();

    expect(await poller.pollOnce()).toEqual({ matched: 2, ingested: 2, duplicates: 0, failed: 0 });
    expect(ingested).toEqual(['alert-10', 'alert-11']);
    expect(box.searches[0]).toEqual({ since: new Date(NOW - 3 * DAY), gmailQuery: 'from:bank.example' });

    box.messages.set(12, 'alert-12');
    now += 300_000;
    expect(await poller.pollOnce()).toEqual({ matched: 1, ingested: 1, duplicates: 0, failed: 0 });
    expect(ingested).toEqual(['alert-10', 'alert-11', 'alert-12']);
    expect(box.closes).toBe(2);

    const status = poller.status();
    expect(status).toMatchObject({ enabled: true, ingestedTotal: 3, lastError: null, stale: false });
    expect(status.lastSuccessAt).toBe(now);
  });

  it('counts Message-ID duplicates without bumping the ingested total', async () => {
    ingested.push('alert-1');
    box.messages.set(1, 'alert-1');
    const poller = service();
    expect(await poller.pollOnce()).toMatchObject({ ingested: 0, duplicates: 1 });
    expect(poller.status().ingestedTotal).toBe(0);
  });

  it('uses sender criteria on servers without Gmail search', async () => {
    box.gmailSearch = false;
    await service().pollOnce();
    expect(box.searches[0]).toEqual({ since: new Date(NOW - 3 * DAY), senders: ['bank.example'] });
  });

  it('stretches the search window to cover an outage since the last good poll', async () => {
    const poller = service();
    await poller.pollOnce();
    now += 10 * DAY;
    await poller.pollOnce();
    expect(box.searches[1]!.since).toEqual(new Date(NOW - DAY));
  });

  it('retries a failing message up to 3 times, then gives up so it cannot wedge the poller', async () => {
    box.messages.set(5, 'poison');
    ingestImpl = async () => {
      throw new Error('boom');
    };
    const poller = service();
    for (let i = 0; i < 3; i += 1) {
      expect(await poller.pollOnce()).toMatchObject({ matched: 1, failed: 1 });
    }
    expect(poller.status().lastError).toBe('1 message(s) failed to ingest');
    expect(await poller.pollOnce()).toMatchObject({ matched: 0, failed: 0 });
    expect(poller.status().lastError).toBeNull();
  });

  it('caps work per run and picks up the rest next time', async () => {
    for (let uid = 1; uid <= 5; uid += 1) box.messages.set(uid, `alert-${uid}`);
    const poller = service(config({ maxPerRun: 2 }));
    expect(await poller.pollOnce()).toMatchObject({ matched: 5, ingested: 2 });
    expect(await poller.pollOnce()).toMatchObject({ matched: 3, ingested: 2 });
    expect(await poller.pollOnce()).toMatchObject({ matched: 1, ingested: 1 });
    expect(ingested).toEqual(['alert-1', 'alert-2', 'alert-3', 'alert-4', 'alert-5']);
  });

  it('forgets seen UIDs when UIDVALIDITY changes (dedupe falls back to Message-ID)', async () => {
    box.messages.set(1, 'alert-1');
    const poller = service();
    await poller.pollOnce();
    box.uidValidity = '2';
    expect(await poller.pollOnce()).toMatchObject({ matched: 1, duplicates: 1 });
  });

  it('records connection errors, backs off, and recovers', async () => {
    box.failConnect = new Error('AUTHENTICATIONFAILED');
    const poller = service();
    await poller.runCycle();
    expect(poller.status().lastError).toBe('AUTHENTICATIONFAILED');
    expect(poller.status().stale).toBe(true);
    expect(poller.nextDelayMs()).toBe(600_000);
    await poller.runCycle();
    expect(poller.nextDelayMs()).toBe(1_200_000);
    box.failConnect = null;
    await poller.runCycle();
    expect(poller.nextDelayMs()).toBe(300_000);
    expect(poller.status().lastError).toBeNull();
  });

  it('does not connect or consume messages while preflight fails', async () => {
    box.messages.set(1, 'alert-1');
    let blocked: string | null = 'MAIL_POLL_RECIPIENT does not match any ingest mailbox';
    const poller = service(config(), () => blocked);
    await expect(poller.pollOnce()).rejects.toThrow(/MAIL_POLL_RECIPIENT/);
    expect(box.connects).toBe(0);
    blocked = null;
    expect(await poller.pollOnce()).toMatchObject({ ingested: 1 });
  });

  it('reports disabled when unconfigured', async () => {
    const poller = new MailPollService(db, null, async () => ({ status: 'x' }), box.connector);
    expect(poller.enabled).toBe(false);
    expect(poller.status().enabled).toBe(false);
    expect(await poller.pollOnce()).toEqual({ matched: 0, ingested: 0, duplicates: 0, failed: 0 });
    expect(box.connects).toBe(0);
  });
});

describe('senderMatches', () => {
  it('matches domains, subdomains and full addresses only', async () => {
    const { senderMatches } = await import('../../src/server/services/context/mail-poll.js');
    const senders = ['bank.example', 'alerts@other.example'];
    expect(senderMatches('alerts@bank.example', senders)).toBe(true);
    expect(senderMatches('Notify@Mail.Bank.Example', senders)).toBe(true);
    expect(senderMatches('x@evilbank.example', senders)).toBe(false);
    expect(senderMatches('x@bank.example.evil.test', senders)).toBe(false);
    expect(senderMatches('alerts@other.example', senders)).toBe(true);
    expect(senderMatches('promo@other.example', senders)).toBe(false);
    expect(senderMatches(null, senders)).toBe(false);
  });
});
