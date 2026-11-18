import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { logger } from '../../lib/logger.js';

/**
 * Always-on mailbox poller. Reads bank alert emails straight from an IMAP
 * mailbox (Gmail with an app password, or any IMAP server) and feeds each
 * message through the same ingest path as POST /api/ingest/email.
 *
 * Off unless MAIL_POLL_IMAP_USER is set. No forwarding rules or Cloudflare
 * Worker are needed, and Message-ID dedupe makes it safe to run next to the
 * Worker path.
 */

/** Gmail search (X-GM-RAW) for bank transaction alerts. Override with MAIL_POLL_QUERY. */
export const DEFAULT_GMAIL_ALERT_QUERY = [
  'from:(ocbc.com OR dbs.com OR posb.com.sg OR uobgroup.com OR uob.com.sg)',
  'subject:("transaction alert" OR "card transaction" OR "transaction made" OR paynow OR paylah'
    + ' OR "deposit in your account" OR "deposited in your account" OR "you have sent money"'
    + ' OR "fund transfer" OR "funds transfer" OR "payment received")',
  '-subject:(statement OR edocument OR "<ADV>" OR cease OR scam OR application OR giro OR device'
    + ' OR login OR update OR discontinued OR nickname)',
].join(' ');

/** Sender domains used on servers without Gmail search (X-GM-RAW). Override with MAIL_POLL_FROM. */
export const DEFAULT_ALERT_SENDERS = ['ocbc.com', 'dbs.com', 'posb.com.sg', 'uobgroup.com', 'uob.com.sg'];

export interface MailPollConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  /** Mailbox path, or 'auto' (Gmail: All Mail, so archived/forwarded mail is still seen; else INBOX). */
  mailbox: string;
  gmailQuery: string;
  senders: string[];
  intervalMs: number;
  lookbackDays: number;
  maxPerRun: number;
  /** Ingest mailbox address (or local part) that decides member + household. */
  recipient: string | null;
}

function intEnv(raw: string | undefined, fallback: number, min: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

export function loadMailPollConfig(env: NodeJS.ProcessEnv = process.env): MailPollConfig | null {
  const user = (env.MAIL_POLL_IMAP_USER || '').trim();
  if (!user) return null;
  let password = env.MAIL_POLL_IMAP_PASSWORD || '';
  if (!password && env.MAIL_POLL_IMAP_PASSWORD_FILE) {
    try {
      password = readFileSync(env.MAIL_POLL_IMAP_PASSWORD_FILE, 'utf8').trim();
    } catch {
      password = '';
    }
  }
  // Gmail shows app passwords as "abcd efgh ijkl mnop"; IMAP wants them without spaces.
  password = password.replace(/\s+/g, '');
  const domain = user.split('@')[1]?.toLowerCase() ?? '';
  const isGmail = domain === 'gmail.com' || domain === 'googlemail.com';
  const host = (env.MAIL_POLL_IMAP_HOST || (isGmail ? 'imap.gmail.com' : '')).trim();
  if (!host || !password) {
    logger.warn('Mail poll disabled: MAIL_POLL_IMAP_HOST and MAIL_POLL_IMAP_PASSWORD are required', {
      hostSet: Boolean(host),
      passwordSet: Boolean(password),
    });
    return null;
  }
  const senders = (env.MAIL_POLL_FROM || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return {
    host,
    port: intEnv(env.MAIL_POLL_IMAP_PORT, 993, 1),
    secure: env.MAIL_POLL_IMAP_TLS !== 'false',
    user,
    password,
    mailbox: (env.MAIL_POLL_MAILBOX || 'auto').trim(),
    gmailQuery: (env.MAIL_POLL_QUERY || DEFAULT_GMAIL_ALERT_QUERY).trim(),
    senders: senders.length > 0 ? senders : DEFAULT_ALERT_SENDERS,
    intervalMs: intEnv(env.MAIL_POLL_INTERVAL_SECONDS, 300, 60) * 1000,
    lookbackDays: intEnv(env.MAIL_POLL_LOOKBACK_DAYS, 3, 1),
    maxPerRun: intEnv(env.MAIL_POLL_MAX_PER_RUN, 25, 1),
    recipient: (env.MAIL_POLL_RECIPIENT || '').trim() || null,
  };
}

/** True when an address is one of `senders` (a full address, or a domain incl. its subdomains). */
export function senderMatches(address: string | null | undefined, senders: string[]): boolean {
  const addr = (address || '').trim().toLowerCase();
  const at = addr.lastIndexOf('@');
  if (at < 0) return false;
  const domain = addr.slice(at + 1);
  return senders.some((raw) => {
    const sender = raw.trim().toLowerCase().replace(/^@/, '');
    if (!sender) return false;
    if (sender.includes('@')) return addr === sender;
    return domain === sender || domain.endsWith(`.${sender}`);
  });
}

export interface MailSession {
  /** Mailbox actually opened (after 'auto' resolution). */
  mailbox: string;
  uidValidity: string;
  /** Server supports Gmail X-GM-RAW search. */
  gmailSearch: boolean;
  search(criteria: { since: Date; gmailQuery?: string; senders?: string[] }): Promise<number[]>;
  fetchSource(uid: number): Promise<Buffer | null>;
  close(): Promise<void>;
}

export type MailConnector = (config: MailPollConfig) => Promise<MailSession>;

export type MailIngestFn = (raw: Buffer) => Promise<{ status: string }>;

export interface MailPollResult {
  matched: number;
  ingested: number;
  duplicates: number;
  failed: number;
}

export interface MailPollStatus {
  enabled: boolean;
  account?: string;
  mailbox?: string;
  intervalSeconds?: number;
  lastPollAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  lastIngestedAt: number | null;
  ingestedTotal: number;
  stale: boolean;
}

const MAX_ATTEMPTS = 3;
const SEEN_RETENTION_MS = 400 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Never let credentials leak into the status row or logs.
  return message.slice(0, 300);
}

export class MailPollService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private consecutiveFailures = 0;

  constructor(
    private db: Database.Database,
    private config: MailPollConfig | null,
    private ingest: MailIngestFn,
    private connect: MailConnector,
    options: {
      now?: () => number;
      /** Returns an error message when ingestion cannot run yet (e.g. unknown recipient). */
      preflight?: () => string | null;
    } = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.preflight = options.preflight ?? (() => null);
  }

  private now: () => number;
  private preflight: () => string | null;

  get enabled(): boolean {
    return this.config !== null;
  }

  get target(): string | null {
    return this.config?.recipient ?? null;
  }

  private get sourceKey(): string {
    const c = this.config!;
    return `${c.user.toLowerCase()}@${c.host.toLowerCase()}/${c.mailbox}`;
  }

  private ensureState(): void {
    this.db.prepare(`
      INSERT INTO mail_poll_state (source_key, last_poll_at, ingested_total)
      VALUES (?, NULL, 0)
      ON CONFLICT(source_key) DO NOTHING
    `).run(this.sourceKey);
  }

  private state(): {
    uid_validity: string | null;
    last_poll_at: number | null;
    last_success_at: number | null;
    last_error: string | null;
    last_ingested_at: number | null;
    ingested_total: number;
  } | undefined {
    return this.db.prepare(
      'SELECT uid_validity, last_poll_at, last_success_at, last_error, last_ingested_at, ingested_total FROM mail_poll_state WHERE source_key = ?',
    ).get(this.sourceKey) as ReturnType<MailPollService['state']>;
  }

  status(): MailPollStatus {
    if (!this.config) {
      return {
        enabled: false,
        lastPollAt: null,
        lastSuccessAt: null,
        lastError: null,
        lastIngestedAt: null,
        ingestedTotal: 0,
        stale: false,
      };
    }
    const row = this.state();
    const lastSuccessAt = row?.last_success_at ?? null;
    return {
      enabled: true,
      account: this.config.user,
      mailbox: this.config.mailbox,
      intervalSeconds: Math.round(this.config.intervalMs / 1000),
      lastPollAt: row?.last_poll_at ?? null,
      lastSuccessAt,
      lastError: row?.last_error ?? null,
      lastIngestedAt: row?.last_ingested_at ?? null,
      ingestedTotal: row?.ingested_total ?? 0,
      stale: lastSuccessAt === null || this.now() - lastSuccessAt > this.config.intervalMs * 3,
    };
  }

  /** One poll cycle. Throws on connection/search errors (caller backs off). */
  async pollOnce(): Promise<MailPollResult> {
    if (!this.config) return { matched: 0, ingested: 0, duplicates: 0, failed: 0 };
    const config = this.config;
    this.ensureState();
    const key = this.sourceKey;
    const startedAt = this.now();
    this.db.prepare('UPDATE mail_poll_state SET last_poll_at = ? WHERE source_key = ?').run(startedAt, key);

    const result: MailPollResult = { matched: 0, ingested: 0, duplicates: 0, failed: 0 };
    let session: MailSession | null = null;
    try {
      const blocked = this.preflight();
      if (blocked) throw new Error(blocked);
      session = await this.connect(config);
      const prior = this.state();
      if (prior?.uid_validity && prior.uid_validity !== session.uidValidity) {
        // Mailbox was recreated; UIDs mean something else now. Message-ID dedupe still protects us.
        this.db.prepare('DELETE FROM mail_poll_seen WHERE source_key = ?').run(key);
      }
      this.db.prepare('UPDATE mail_poll_state SET uid_validity = ? WHERE source_key = ?').run(session.uidValidity, key);

      // Window: the lookback, stretched to cover any outage since the last good poll.
      const lookbackStart = startedAt - config.lookbackDays * DAY_MS;
      const outageStart = prior?.last_success_at ? prior.last_success_at - DAY_MS : lookbackStart;
      const since = new Date(Math.min(lookbackStart, outageStart));

      const uids = await session.search(session.gmailSearch
        ? { since, gmailQuery: config.gmailQuery }
        : { since, senders: config.senders });
      const seen = new Set(
        (this.db.prepare(
          "SELECT uid FROM mail_poll_seen WHERE source_key = ? AND (status != 'failed' OR attempts >= ?)",
        ).all(key, MAX_ATTEMPTS) as Array<{ uid: number }>).map((row) => row.uid),
      );
      const pending = [...new Set(uids)].filter((uid) => !seen.has(uid)).sort((a, b) => a - b);
      result.matched = pending.length;

      for (const uid of pending.slice(0, config.maxPerRun)) {
        try {
          const raw = await session.fetchSource(uid);
          if (!raw) {
            this.markSeen(uid, 'missing');
            continue;
          }
          const outcome = await this.ingest(raw);
          if (outcome.status === 'duplicate') {
            result.duplicates += 1;
          } else {
            result.ingested += 1;
            this.db.prepare(`
              UPDATE mail_poll_state
              SET ingested_total = ingested_total + 1, last_ingested_at = ?
              WHERE source_key = ?
            `).run(this.now(), key);
          }
          this.markSeen(uid, outcome.status || 'done');
        } catch (error) {
          result.failed += 1;
          const attempts = this.markFailed(uid);
          logger.warn('Mail poll: message ingest failed', {
            uid,
            attempts,
            givingUp: attempts >= MAX_ATTEMPTS,
            error: errorText(error),
          });
        }
      }

      this.db.prepare(`
        UPDATE mail_poll_state SET last_success_at = ?, last_error = ? WHERE source_key = ?
      `).run(this.now(), result.failed > 0 ? `${result.failed} message(s) failed to ingest` : null, key);
      this.db.prepare('DELETE FROM mail_poll_seen WHERE source_key = ? AND updated_at < ?')
        .run(key, this.now() - SEEN_RETENTION_MS);
      return result;
    } catch (error) {
      this.db.prepare('UPDATE mail_poll_state SET last_error = ? WHERE source_key = ?').run(errorText(error), key);
      throw error;
    } finally {
      if (session) {
        await session.close().catch(() => undefined);
      }
    }
  }

  private markSeen(uid: number, status: string): void {
    this.db.prepare(`
      INSERT INTO mail_poll_seen (source_key, uid, status, attempts, updated_at)
      VALUES (?, ?, ?, 0, ?)
      ON CONFLICT(source_key, uid) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at
    `).run(this.sourceKey, uid, status, this.now());
  }

  private markFailed(uid: number): number {
    this.db.prepare(`
      INSERT INTO mail_poll_seen (source_key, uid, status, attempts, updated_at)
      VALUES (?, ?, 'failed', 1, ?)
      ON CONFLICT(source_key, uid) DO UPDATE SET status = 'failed', attempts = attempts + 1, updated_at = excluded.updated_at
    `).run(this.sourceKey, uid, this.now());
    const row = this.db.prepare('SELECT attempts FROM mail_poll_seen WHERE source_key = ? AND uid = ?')
      .get(this.sourceKey, uid) as { attempts: number };
    return row.attempts;
  }

  /** Delay before the next poll: the interval, doubled per consecutive failure, capped at 1h. */
  nextDelayMs(): number {
    const base = this.config?.intervalMs ?? 300_000;
    if (this.consecutiveFailures === 0) return base;
    return Math.min(base * 2 ** this.consecutiveFailures, 60 * 60 * 1000);
  }

  async runCycle(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.pollOnce();
      this.consecutiveFailures = 0;
      if (result.matched > 0 || result.failed > 0) {
        logger.info('Mail poll complete', { ...result });
      }
    } catch (error) {
      this.consecutiveFailures += 1;
      logger.warn('Mail poll failed', {
        error: errorText(error),
        consecutiveFailures: this.consecutiveFailures,
        retryInSeconds: Math.round(this.nextDelayMs() / 1000),
      });
    } finally {
      this.running = false;
    }
  }

  start(initialDelayMs = 15_000): void {
    if (!this.config || this.timer) return;
    logger.info('Mail poll enabled', {
      host: this.config.host,
      mailbox: this.config.mailbox,
      intervalSeconds: Math.round(this.config.intervalMs / 1000),
      lookbackDays: this.config.lookbackDays,
      recipientSet: Boolean(this.config.recipient),
    });
    const schedule = (delay: number) => {
      this.timer = setTimeout(() => {
        void this.runCycle().finally(() => schedule(this.nextDelayMs()));
      }, delay);
      this.timer.unref?.();
    };
    schedule(initialDelayMs);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** Real IMAP connector (imapflow). Loaded lazily so tests and disabled installs never open sockets. */
export const imapConnector: MailConnector = async (config) => {
  const { ImapFlow } = await import('imapflow');
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.password },
    logger: false,
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 120_000,
  });
  // Unhandled 'error' events would crash the process.
  client.on('error', (error: unknown) => {
    logger.warn('Mail poll IMAP error', { error: errorText(error) });
  });
  await client.connect();
  try {
    const gmailSearch = client.capabilities.has('X-GM-EXT-1');
    let mailbox = config.mailbox;
    if (mailbox === 'auto') {
      mailbox = 'INBOX';
      if (gmailSearch) {
        const all = (await client.list()).find((box) => box.specialUse === '\\All');
        if (all) mailbox = all.path;
      }
    }
    const lock = await client.getMailboxLock(mailbox, { readOnly: true });
    const opened = client.mailbox;
    const uidValidity = opened && typeof opened === 'object' ? String(opened.uidValidity) : '0';
    return {
      mailbox,
      uidValidity,
      gmailSearch,
      async search(criteria) {
        const query: Record<string, unknown> = { since: criteria.since };
        if (criteria.gmailQuery) {
          query.gmraw = criteria.gmailQuery;
        } else if (criteria.senders && criteria.senders.length > 0) {
          const froms = criteria.senders.map((from) => ({ from }));
          if (froms.length === 1) Object.assign(query, froms[0]);
          else query.or = froms;
        }
        const found = await client.search(query, { uid: true });
        const uids = Array.isArray(found) ? found : [];
        if (!criteria.senders || criteria.senders.length === 0 || uids.length === 0) return uids;
        // Some servers ignore FROM in SEARCH; confirm the sender from the envelope.
        const matched: number[] = [];
        for await (const msg of client.fetch(uids.join(','), { envelope: true }, { uid: true })) {
          if (msg.envelope?.from?.some((entry) => senderMatches(entry.address, criteria.senders!))) {
            matched.push(msg.uid);
          }
        }
        return matched;
      },
      async fetchSource(uid) {
        const message = await client.fetchOne(String(uid), { source: true }, { uid: true });
        return message && message.source ? Buffer.from(message.source) : null;
      },
      async close() {
        lock.release();
        await client.logout().catch(() => client.close());
      },
    };
  } catch (error) {
    await client.logout().catch(() => client.close());
    throw error;
  }
};
