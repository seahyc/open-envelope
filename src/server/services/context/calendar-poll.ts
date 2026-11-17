import type Database from 'better-sqlite3';
import { contextFlag } from '../../lib/context-flags.js';
import { contextSecretKey, sealString, unsealString } from '../../lib/sealed-secret.js';
import { logger } from '../../lib/logger.js';
import { householdIdForMember } from '../../lib/member-identity.js';
import { hh } from '../../lib/tenancy.js';

export interface CalendarPoller {
  poll(): Promise<number>;
  setFeed(memberId: string, url: string): void;
}

export function parseIcalEvents(ics: string, memberId: string, fetchedAt: number): Array<{
  id: string;
  memberId: string;
  title: string;
  location: string | null;
  startsAt: number;
  endsAt: number;
  fetchedAt: number;
}> {
  const unfolded = ics.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
  const blocks = unfolded.split(/BEGIN:VEVENT/i).slice(1);
  const events = [];
  for (const block of blocks) {
    const body = block.split(/END:VEVENT/i)[0] ?? '';
    const uid: string = icalField(body, 'UID') || `evt-${events.length}`;
    const title = icalField(body, 'SUMMARY') || '(no title)';
    const location = icalField(body, 'LOCATION');
    const start = parseIcalDate(icalField(body, 'DTSTART'));
    const end = parseIcalDate(icalField(body, 'DTEND')) ?? (start != null ? start + 60 * 60 * 1000 : null);
    if (start == null || end == null) continue;
    events.push({
      id: `${memberId}:${uid}`,
      memberId,
      title,
      location,
      startsAt: start,
      endsAt: end,
      fetchedAt,
    });
  }
  return events;
}

function icalField(body: string, name: string): string | null {
  const match = body.match(new RegExp(`^${name}(?:;[^:]*)?:(.*)$`, 'im'));
  return match?.[1]?.replace(/\\n/g, ' ').replace(/\\,/g, ',').trim() || null;
}

export function isGoogleCalendarHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'calendar.google.com' || h.endsWith('.calendar.google.com');
}

export function isAllowedIcalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && isGoogleCalendarHost(parsed.hostname);
  } catch {
    return false;
  }
}

function parseIcalDate(raw: string | null): number | null {
  if (!raw) return null;
  const compact = raw.replace(/[^0-9TZ]/g, '');
  const m = compact.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  const hour = Number(m[4] ?? 0);
  const min = Number(m[5] ?? 0);
  const sec = Number(m[6] ?? 0);
  if (m[7] === 'Z' || m[4]) return Date.UTC(year, month, day, hour, min, sec);
  return Date.UTC(year, month, day, hour, min, sec);
}

export class CalendarPollService implements CalendarPoller {
  constructor(
    private db: Database.Database,
    private fetchImpl: typeof fetch = fetch,
    private now: () => number = () => Date.now(),
  ) {}

  bootstrapFromEnv(env: NodeJS.ProcessEnv = process.env): void {
    const raw = env.CALENDAR_ICAL_URLS || '';
    for (const part of raw.split(',').map((item) => item.trim()).filter(Boolean)) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      const slug = part.slice(0, eq).trim();
      const url = part.slice(eq + 1).trim();
      const member = this.db.prepare(
        'SELECT id FROM household_members WHERE id = ? OR lower(name) = lower(?)'
      ).get(slug, slug) as { id: string } | undefined;
      if (member && url) this.setFeed(member.id, url);
    }
  }

  setFeed(memberId: string, url: string, lastError: string | null = null): void {
    const key = contextSecretKey();
    if (!key) return;
    const sealed = sealString(url, key);
    this.db.prepare(`
      INSERT INTO member_calendar_feeds (household_id, member_id, ical_url_sealed, updated_at, last_error, last_fetched_at)
      VALUES (?, ?, ?, ?, ?, NULL)
      ON CONFLICT(member_id) DO UPDATE SET
        ical_url_sealed = excluded.ical_url_sealed,
        updated_at = excluded.updated_at,
        last_error = excluded.last_error,
        household_id = excluded.household_id
    `).run(householdIdForMember(this.db, memberId) ?? hh(), memberId, sealed, this.now(), lastError);
  }

  async validateAndSet(memberId: string, url: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!isAllowedIcalUrl(url)) {
      return { ok: false, error: 'Paste the Google Calendar secret iCal HTTPS URL.' };
    }
    try {
      const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(8000), redirect: 'follow' });
      if (!response.ok) {
        this.setFeed(memberId, url, `fetch ${response.status}`);
        return { ok: false, error: 'Could not fetch that calendar.' };
      }
      const finalHost = new URL(response.url || url).hostname.toLowerCase();
      if (!isGoogleCalendarHost(finalHost)) {
        return { ok: false, error: 'Paste the Google Calendar secret iCal HTTPS URL.' };
      }
      const ics = await response.text();
      if (!/BEGIN:VCALENDAR/i.test(ics)) {
        this.setFeed(memberId, url, 'not ical');
        return { ok: false, error: 'That URL did not return a calendar.' };
      }
      this.setFeed(memberId, url, null);
      this.db.prepare(
        'UPDATE member_calendar_feeds SET last_fetched_at = ?, last_error = NULL WHERE member_id = ?',
      ).run(this.now(), memberId);
      const events = parseIcalEvents(ics, memberId, this.now());
      for (const event of events) {
        this.db.prepare(`
          INSERT INTO calendar_events (id, household_id, member_id, title, location, starts_at, ends_at, fetched_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            location = excluded.location,
            starts_at = excluded.starts_at,
            ends_at = excluded.ends_at,
            fetched_at = excluded.fetched_at
        `).run(
          event.id,
          householdIdForMember(this.db, event.memberId) ?? hh(),
          event.memberId,
          event.title,
          event.location,
          event.startsAt,
          event.endsAt,
          event.fetchedAt,
        );
      }
      return { ok: true };
    } catch (error) {
      logger.warn('Calendar validate failed', {
        memberId,
        error: error instanceof Error ? error.message : String(error),
      });
      try {
        this.setFeed(memberId, url, 'fetch failed');
      } catch {
        /* ignore */
      }
      return { ok: false, error: 'Could not fetch that calendar.' };
    }
  }

  async poll(): Promise<number> {
    if (!contextFlag('calendar')) return 0;
    const key = contextSecretKey();
    if (!key) return 0;
    const feeds = this.db.prepare(
      'SELECT member_id, ical_url_sealed FROM member_calendar_feeds'
    ).all() as Array<{ member_id: string; ical_url_sealed: string }>;
    let upserted = 0;
    for (const feed of feeds) {
      let url = '';
      try {
        url = unsealString(feed.ical_url_sealed, key);
        const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(8000) });
        if (!response.ok) {
          this.db.prepare(
            'UPDATE member_calendar_feeds SET last_error = ?, last_fetched_at = ? WHERE member_id = ?',
          ).run(`fetch ${response.status}`, this.now(), feed.member_id);
          continue;
        }
        const ics = await response.text();
        this.db.prepare(
          'UPDATE member_calendar_feeds SET last_error = NULL, last_fetched_at = ? WHERE member_id = ?',
        ).run(this.now(), feed.member_id);
        const events = parseIcalEvents(ics, feed.member_id, this.now());
        for (const event of events) {
          this.db.prepare(`
            INSERT INTO calendar_events (id, household_id, member_id, title, location, starts_at, ends_at, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              title = excluded.title,
              location = excluded.location,
              starts_at = excluded.starts_at,
              ends_at = excluded.ends_at,
              fetched_at = excluded.fetched_at
          `).run(
            event.id,
            householdIdForMember(this.db, event.memberId) ?? hh(),
            event.memberId,
            event.title,
            event.location,
            event.startsAt,
            event.endsAt,
            event.fetchedAt
          );
          upserted += 1;
        }
      } catch (error) {
        logger.warn('Calendar poll failed', {
          memberId: feed.member_id,
          error: error instanceof Error ? error.message : String(error),
        });
        this.db.prepare(
          'UPDATE member_calendar_feeds SET last_error = ? WHERE member_id = ?',
        ).run('fetch failed', feed.member_id);
      }
    }
    return upserted;
  }
}
