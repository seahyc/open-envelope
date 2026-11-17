import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { contextFlag } from '../../lib/context-flags.js';
import { hashSecret, verifySecret } from '../../lib/sealed-secret.js';
import { householdIdForMember, resolveCurrentMember, slugFromName, type MemberRow } from '../../lib/member-identity.js';
import { hh } from '../../lib/tenancy.js';
import { GMAIL_RECEIPT_FILTER } from './gmail-filter.js';
import type { GmailForwardingVerify } from './gmail-verify.js';
import type { CalendarPollService } from './calendar-poll.js';
import { LocationIngestService } from './location-ingest.js';
import { HooksService, type HookCard } from './hooks-service.js';

export const CONNECTION_STALE_MS = 7 * 24 * 60 * 60 * 1000;

export type ConnectionStatus = 'unset' | 'waiting' | 'healthy' | 'stale' | 'error';
export type SourceKind = 'email' | 'calendar' | 'location' | 'extension' | 'webhook';

export interface SourceCard {
  kind: SourceKind;
  status: ConnectionStatus;
  flagOn: boolean;
  lastReceivedAt: number | null;
  count: number;
  error: string | null;
  setup: Record<string, string | null>;
  hooks?: HookCard[];
}

export interface ConnectionsSnapshot {
  member: { id: string; name: string; email: string; slug: string };
  ingestDomain: string;
  gmailFilter: string;
  owntracksUrl: string;
  staleAfterDays: number;
  sources: SourceCard[];
}

export class ConnectionsService {
  constructor(
    private db: Database.Database,
    private calendar: CalendarPollService,
    private location: LocationIngestService,
    private now: () => number = () => Date.now(),
    private env: NodeJS.ProcessEnv = process.env,
  ) {}

  snapshot(authUser: string | undefined, publicOrigin: string): ConnectionsSnapshot | null {
    const member = resolveCurrentMember(this.db, authUser);
    if (!member) return null;
    const slug = slugFromName(member.name);
    const ingestDomain = (this.env.EMAIL_INGEST_DOMAIN || '').trim();
    return {
      member: { id: member.id, name: member.name, email: member.email, slug },
      ingestDomain,
      gmailFilter: GMAIL_RECEIPT_FILTER,
      owntracksUrl: `${publicOrigin.replace(/\/$/, '')}/api/ingest/location`,
      staleAfterDays: 7,
      sources: [
        this.emailCard(member, ingestDomain),
        this.calendarCard(member),
        this.locationCard(member),
        this.extensionCard(member),
        this.webhookCard(member, publicOrigin),
      ],
    };
  }

  enableMailbox(member: MemberRow): { address: string; localPart: string } {
    const domain = (this.env.EMAIL_INGEST_DOMAIN || '').trim();
    if (!domain) throw new Error('EMAIL_INGEST_DOMAIN is not set');
    const existing = this.db.prepare(
      'SELECT local_part FROM ingest_mailboxes WHERE member_id = ?',
    ).get(member.id) as { local_part: string } | undefined;
    if (existing) {
      return { address: `${existing.local_part}@${domain}`, localPart: existing.local_part };
    }
    const localPart = this.mintLocalPart(member.name);
    this.db.prepare(`
      INSERT INTO ingest_mailboxes (id, household_id, member_id, local_part, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(crypto.randomBytes(8).toString('hex'), hh(), member.id, localPart, this.now());
    return { address: `${localPart}@${domain}`, localPart };
  }

  regenerateMailbox(member: MemberRow): { address: string; localPart: string } {
    const domain = (this.env.EMAIL_INGEST_DOMAIN || '').trim();
    if (!domain) throw new Error('EMAIL_INGEST_DOMAIN is not set');
    const localPart = this.mintLocalPart(member.name);
    const existing = this.db.prepare(
      'SELECT id FROM ingest_mailboxes WHERE member_id = ?',
    ).get(member.id) as { id: string } | undefined;
    if (existing) {
      this.db.prepare(`
        UPDATE ingest_mailboxes
        SET local_part = ?, gmail_verify_code = NULL, gmail_verify_link = NULL, gmail_verify_at = NULL,
            last_received_at = NULL, last_error = NULL, last_parse_at = NULL, last_parse_method = NULL,
            last_parse_confidence = NULL, last_parse_status = NULL
        WHERE member_id = ?
      `).run(localPart, member.id);
    } else {
      this.db.prepare(`
        INSERT INTO ingest_mailboxes (id, household_id, member_id, local_part, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(crypto.randomBytes(8).toString('hex'), hh(), member.id, localPart, this.now());
    }
    return { address: `${localPart}@${domain}`, localPart };
  }

  mailboxForRecipient(recipient: string | null | undefined): { memberId: string; localPart: string; householdId: string | null } | null {
    if (!recipient) return null;
    const local = recipient.trim().toLowerCase().split('@')[0] ?? '';
    if (!local) return null;
    const candidates = [local];
    const plus = local.indexOf('+');
    if (plus >= 0) {
      const tag = local.slice(plus + 1);
      if (tag) candidates.push(tag);
    }
    for (const candidate of candidates) {
      const row = this.db.prepare(
        'SELECT member_id, local_part FROM ingest_mailboxes WHERE lower(local_part) = ?',
      ).get(candidate) as { member_id: string; local_part: string } | undefined;
      if (row) {
        return { memberId: row.member_id, localPart: row.local_part, householdId: householdIdForMember(this.db, row.member_id) };
      }
    }
    return null;
  }

  recordInbound(
    memberId: string | null,
    documentHash: string,
    kind: string,
    parse?: { method: string; confidence: number; status: string },
  ): void {
    this.db.prepare(`
      INSERT INTO inbound_mail (id, household_id, member_id, document_hash, kind, received_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomBytes(8).toString('hex'),
      memberId ? householdIdForMember(this.db, memberId) ?? hh() : hh(),
      memberId,
      documentHash,
      kind,
      this.now(),
    );
    if (memberId) {
      if (parse && kind !== 'gmail_verify') {
        this.db.prepare(`
          UPDATE ingest_mailboxes
          SET last_received_at = ?, last_error = NULL, last_parse_at = ?, last_parse_method = ?,
              last_parse_confidence = ?, last_parse_status = ?
          WHERE member_id = ?
        `).run(this.now(), this.now(), parse.method, parse.confidence, parse.status, memberId);
      } else {
        this.db.prepare(
          'UPDATE ingest_mailboxes SET last_received_at = ?, last_error = NULL WHERE member_id = ?',
        ).run(this.now(), memberId);
      }
    }
  }

  private mintLocalPart(name: string): string {
    return `${slugFromName(name)}-${crypto.randomBytes(8).toString('hex')}`;
  }

  recordGmailVerify(memberId: string, parsed: GmailForwardingVerify): void {
    this.db.prepare(`
      UPDATE ingest_mailboxes
      SET gmail_verify_code = ?, gmail_verify_link = ?, gmail_verify_at = ?, last_error = NULL
      WHERE member_id = ?
    `).run(parsed.code, parsed.link, this.now(), memberId);
  }

  async saveCalendar(memberId: string, url: string): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.calendar.validateAndSet(memberId, url.trim());
  }

  mintLocation(member: MemberRow): { deviceId: string; secret: string } {
    const deviceId = `${slugFromName(member.name)}-phone`;
    const secret = crypto.randomBytes(18).toString('base64url');
    this.location.upsertDevice(deviceId, member.id, secret);
    return { deviceId, secret };
  }

  mintExtension(member: MemberRow): { token: string; tokenId: string } {
    this.db.prepare(
      'UPDATE extension_tokens SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL',
    ).run(this.now(), member.id);
    const tokenId = crypto.randomBytes(8).toString('hex');
    const secret = crypto.randomBytes(24).toString('base64url');
    const hashed = hashSecret(secret);
    this.db.prepare(`
      INSERT INTO extension_tokens (
        id, household_id, member_id, token_salt, token_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(tokenId, hh(), member.id, hashed.salt, hashed.hash, this.now());
    return { token: `ext.${tokenId}.${secret}`, tokenId };
  }

  verifyExtensionToken(token: string): string | null {
    const parts = token.trim().split('.');
    if (parts.length !== 3 || parts[0] !== 'ext' || !parts[1] || !parts[2]) return null;
    const row = this.db.prepare(
      'SELECT id, member_id, token_salt, token_hash, revoked_at FROM extension_tokens WHERE id = ?',
    ).get(parts[1]) as
      | { id: string; member_id: string; token_salt: string; token_hash: string; revoked_at: number | null }
      | undefined;
    if (!row || row.revoked_at) return null;
    if (!verifySecret(parts[2], row.token_salt, row.token_hash)) return null;
    this.db.prepare(
      'UPDATE extension_tokens SET last_used_at = ?, last_error = NULL WHERE id = ?',
    ).run(this.now(), row.id);
    return row.member_id;
  }

  markExtensionError(memberId: string, message: string): void {
    this.db.prepare(`
      UPDATE extension_tokens SET last_error = ? WHERE member_id = ? AND revoked_at IS NULL
    `).run(message, memberId);
  }

  disconnect(memberId: string, kind: SourceKind, deleteData: boolean): void {
    if (kind === 'email') {
      if (deleteData) {
        const orders = this.db.prepare(
          "SELECT id FROM orders WHERE member_id = ? AND IFNULL(source, 'email') = 'email'",
        ).all(memberId) as Array<{ id: string }>;
        for (const order of orders) {
          this.db.prepare('DELETE FROM order_items WHERE order_id = ?').run(order.id);
          this.db.prepare('DELETE FROM orders WHERE id = ?').run(order.id);
        }
        this.db.prepare('DELETE FROM inbound_mail WHERE member_id = ?').run(memberId);
      }
      this.db.prepare('DELETE FROM ingest_mailboxes WHERE member_id = ?').run(memberId);
      return;
    }
    if (kind === 'calendar') {
      if (deleteData) this.db.prepare('DELETE FROM calendar_events WHERE member_id = ?').run(memberId);
      this.db.prepare('DELETE FROM member_calendar_feeds WHERE member_id = ?').run(memberId);
      return;
    }
    if (kind === 'location') {
      if (deleteData) {
        this.db.prepare('DELETE FROM location_points WHERE member_id = ?').run(memberId);
        this.db.prepare('DELETE FROM place_visits WHERE member_id = ?').run(memberId);
      }
      this.db.prepare('DELETE FROM location_devices WHERE member_id = ?').run(memberId);
      return;
    }
    if (kind === 'webhook') {
      new HooksService(this.db, this.now).disconnect(memberId, null, deleteData);
      return;
    }
    if (deleteData) {
      const orders = this.db.prepare(
        "SELECT id FROM orders WHERE member_id = ? AND source = 'extension'",
      ).all(memberId) as Array<{ id: string }>;
      for (const order of orders) {
        this.db.prepare('DELETE FROM order_items WHERE order_id = ?').run(order.id);
        this.db.prepare('DELETE FROM orders WHERE id = ?').run(order.id);
      }
    }
    this.db.prepare('DELETE FROM extension_tokens WHERE member_id = ?').run(memberId);
  }

  private emailCard(member: MemberRow, domain: string): SourceCard {
    const box = this.db.prepare(
      `SELECT local_part, last_received_at, last_error, gmail_verify_code, gmail_verify_link, gmail_verify_at,
              last_parse_method, last_parse_confidence, last_parse_status, last_parse_at
       FROM ingest_mailboxes WHERE member_id = ?`,
    ).get(member.id) as {
      local_part: string;
      last_received_at: number | null;
      last_error: string | null;
      gmail_verify_code: string | null;
      gmail_verify_link: string | null;
      gmail_verify_at: number | null;
      last_parse_method: string | null;
      last_parse_confidence: number | null;
      last_parse_status: string | null;
      last_parse_at: number | null;
    } | undefined;
    const count = (this.db.prepare(
      'SELECT COUNT(*) as n FROM inbound_mail WHERE member_id = ?',
    ).get(member.id) as { n: number }).n;
    const firstMailAt = (this.db.prepare(
      `SELECT MIN(received_at) as t FROM inbound_mail WHERE member_id = ? AND kind != 'gmail_verify'`,
    ).get(member.id) as { t: number | null }).t;
    return {
      kind: 'email',
      status: deriveStatus(Boolean(box), box?.last_received_at ?? null, box?.last_error ?? null, this.now()),
      flagOn: Boolean(domain),
      lastReceivedAt: box?.last_received_at ?? null,
      count,
      error: box?.last_error ?? null,
      setup: {
        address: box && domain ? `${box.local_part}@${domain}` : null,
        gmailFilter: GMAIL_RECEIPT_FILTER,
        gmailVerifyCode: box?.gmail_verify_code ?? null,
        gmailVerifyLink: box?.gmail_verify_link ?? null,
        emailPhase: emailPhase(box, firstMailAt),
        firstMailAt: firstMailAt != null ? String(firstMailAt) : null,
        lastParseMethod: box?.last_parse_method ?? null,
        lastParseConfidence: box?.last_parse_confidence != null ? String(box.last_parse_confidence) : null,
        lastParseStatus: box?.last_parse_status ?? null,
        lastParseAt: box?.last_parse_at != null ? String(box.last_parse_at) : null,
      },
    };
  }

  private calendarCard(member: MemberRow): SourceCard {
    const feed = this.db.prepare(
      'SELECT updated_at, last_error, last_fetched_at FROM member_calendar_feeds WHERE member_id = ?',
    ).get(member.id) as { updated_at: number; last_error: string | null; last_fetched_at: number | null } | undefined;
    const count = (this.db.prepare(
      'SELECT COUNT(*) as n FROM calendar_events WHERE member_id = ?',
    ).get(member.id) as { n: number }).n;
    const last = feed?.last_fetched_at ?? (count > 0
      ? (this.db.prepare(
        'SELECT MAX(fetched_at) as t FROM calendar_events WHERE member_id = ?',
      ).get(member.id) as { t: number | null }).t
      : null);
    return {
      kind: 'calendar',
      status: deriveStatus(Boolean(feed), last, feed?.last_error ?? null, this.now()),
      flagOn: contextFlag('calendar', this.env),
      lastReceivedAt: last,
      count,
      error: feed?.last_error ?? null,
      setup: { configured: feed ? '1' : null },
    };
  }

  private locationCard(member: MemberRow): SourceCard {
    const device = this.db.prepare(
      'SELECT id FROM location_devices WHERE member_id = ? ORDER BY created_at LIMIT 1',
    ).get(member.id) as { id: string } | undefined;
    const stats = this.db.prepare(
      `SELECT COUNT(*) as n, MAX(received_at) as last FROM location_points WHERE member_id = ?`,
    ).get(member.id) as { n: number; last: number | null };
    return {
      kind: 'location',
      status: deriveStatus(Boolean(device), stats.last, null, this.now()),
      flagOn: contextFlag('location', this.env),
      lastReceivedAt: stats.last,
      count: stats.n,
      error: null,
      setup: {
        deviceId: device?.id ?? null,
        username: device?.id ?? null,
      },
    };
  }

  private extensionCard(member: MemberRow): SourceCard {
    const token = this.db.prepare(
      `SELECT last_used_at, last_error, revoked_at FROM extension_tokens
       WHERE member_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(member.id) as { last_used_at: number | null; last_error: string | null; revoked_at: number | null } | undefined;
    const active = Boolean(token && !token.revoked_at);
    const count = (this.db.prepare(
      "SELECT COUNT(*) as n FROM orders WHERE member_id = ? AND source = 'extension'",
    ).get(member.id) as { n: number }).n;
    return {
      kind: 'extension',
      status: deriveStatus(active, token?.last_used_at ?? null, token?.last_error ?? null, this.now()),
      flagOn: contextFlag('orders', this.env),
      lastReceivedAt: token?.last_used_at ?? null,
      count,
      error: token?.last_error ?? null,
      setup: { minted: active ? '1' : null },
    };
  }

  private webhookCard(member: MemberRow, publicOrigin: string): SourceCard {
    const hooks = new HooksService(this.db, this.now).list(member.id, publicOrigin);
    const last = hooks.reduce<number | null>((max, hook) => {
      if (hook.lastReceivedAt == null) return max;
      if (max == null || hook.lastReceivedAt > max) return hook.lastReceivedAt;
      return max;
    }, null);
    const error = hooks.find((hook) => hook.error)?.error ?? null;
    const count = hooks.reduce((sum, hook) => sum + hook.receivedCount, 0);
    return {
      kind: 'webhook',
      status: deriveStatus(hooks.length > 0, last, error, this.now()),
      flagOn: contextFlag('webhook', this.env),
      lastReceivedAt: last,
      count,
      error,
      setup: { hookCount: String(hooks.length) },
      hooks,
    };
  }
}

export function emailPhase(
  box: { gmail_verify_code: string | null } | undefined,
  firstMailAt: number | null,
): string | null {
  if (!box) return 'needs_mailbox';
  if (firstMailAt) return 'connected';
  if (box.gmail_verify_code) return 'waiting_test_alert';
  return 'waiting_forwarding_confirm';
}

export function deriveStatus(
  configured: boolean,
  lastAt: number | null,
  error: string | null,
  now: number,
): ConnectionStatus {
  if (!configured) return 'unset';
  if (error) return 'error';
  if (!lastAt) return 'waiting';
  if (now - lastAt > CONNECTION_STALE_MS) return 'stale';
  return 'healthy';
}

export function seedConnectionsScenario(
  db: Database.Database,
  memberId: string,
  scenario: 'empty' | 'mixed',
  now = Date.now(),
): void {
  db.prepare('DELETE FROM inbound_mail WHERE member_id = ?').run(memberId);
  db.prepare('DELETE FROM ingest_mailboxes WHERE member_id = ?').run(memberId);
  db.prepare('DELETE FROM extension_tokens WHERE member_id = ?').run(memberId);
  db.prepare('DELETE FROM location_points WHERE member_id = ?').run(memberId);
  db.prepare('DELETE FROM location_devices WHERE member_id = ?').run(memberId);
  db.prepare('DELETE FROM calendar_events WHERE member_id = ?').run(memberId);
  db.prepare('DELETE FROM member_calendar_feeds WHERE member_id = ?').run(memberId);
  db.prepare('DELETE FROM ingest_hook_events WHERE hook_id IN (SELECT id FROM ingest_hooks WHERE member_id = ?)').run(memberId);
  db.prepare('DELETE FROM ingest_hooks WHERE member_id = ?').run(memberId);
  if (scenario === 'empty') return;

  const hid = householdIdForMember(db, memberId) ?? hh();
  db.prepare(`
    INSERT INTO ingest_mailboxes (
      id, household_id, member_id, local_part, created_at, gmail_verify_code, gmail_verify_link, gmail_verify_at
    ) VALUES ('mbox-seed', ?, ?, 'alex-wait01', ?, '84729103', 'https://mail.google.com/mail/#setup/forwardingconfirm/seed', ?)
  `).run(hid, memberId, now, now);

  db.prepare(`
    INSERT INTO member_calendar_feeds (household_id, member_id, ical_url_sealed, updated_at, last_error, last_fetched_at)
    VALUES (?, ?, 'seed', ?, NULL, ?)
  `).run(hid, memberId, now, now);
  db.prepare(`
    INSERT INTO calendar_events (id, household_id, member_id, title, location, starts_at, ends_at, fetched_at)
    VALUES ('cal-seed', ?, ?, 'Dinner', 'Jewel', ?, ?, ?)
  `).run(hid, memberId, now, now + 3600_000, now);

  const locHash = hashSecret('seed-secret');
  db.prepare(`
    INSERT INTO location_devices (id, household_id, member_id, secret_salt, secret_hash, created_at)
    VALUES ('alex-phone', ?, ?, ?, ?, ?)
  `).run(hid, memberId, locHash.salt, locHash.hash, now);
  const staleAt = now - CONNECTION_STALE_MS - 86_400_000;
  db.prepare(`
    INSERT INTO location_points (
      id, household_id, member_id, device_id, lat, lng, recorded_at, received_at
    ) VALUES ('pt-seed', ?, ?, 'alex-phone', 1.36, 103.99, ?, ?)
  `).run(hid, memberId, staleAt, staleAt);

  const extHash = hashSecret('seed-ext');
  db.prepare(`
    INSERT INTO extension_tokens (
      id, household_id, member_id, token_salt, token_hash, created_at, last_error
    ) VALUES ('extseed01', ?, ?, ?, ?, ?, 'page was not an order history')
  `).run(hid, memberId, extHash.salt, extHash.hash, now);
}
