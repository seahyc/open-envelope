import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/server/db/migrations.js';
import { CalendarPollService, parseIcalEvents } from '../../src/server/services/context/calendar-poll.js';
import { unsealString, contextSecretKey } from '../../src/server/lib/sealed-secret.js';

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:dinner-1
SUMMARY:Dinner
LOCATION:Jewel Changi
DTSTART:20261014T140000Z
DTEND:20261014T153000Z
DESCRIPTION:secret notes
ATTENDEE:mailto:sam@example.com
END:VEVENT
END:VCALENDAR`;

describe('calendar iCal poll', () => {
  let db: Database.Database;
  const previous = process.env.CONTEXT_CALENDAR;

  beforeEach(() => {
    process.env.CONTEXT_CALENDAR = '1';
    db = new Database(':memory:');
    runMigrations(db, { quiet: true });
    db.prepare(
      "INSERT INTO household_members (id, name, email, created_at) VALUES ('mem-alex', 'Alex', 'a@example.com', ?)"
    ).run(Date.now());
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.CONTEXT_CALENDAR;
    else process.env.CONTEXT_CALENDAR = previous;
    db.close();
  });

  it('parses title, start, end, location and drops description', () => {
    const events = parseIcalEvents(ICS, 'mem-alex', Date.now());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      title: 'Dinner',
      location: 'Jewel Changi',
      startsAt: Date.UTC(2026, 9, 14, 14, 0, 0),
      endsAt: Date.UTC(2026, 9, 14, 15, 30, 0),
    });
    expect(JSON.stringify(events)).not.toMatch(/secret notes|sam@example.com/i);
  });

  it('seals the iCal URL at rest and upserts events from a mock fetch', async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('calendar.google.com');
      return new Response(ICS, { status: 200 });
    }) as typeof fetch;
    const poller = new CalendarPollService(db, fetchImpl, () => Date.UTC(2026, 9, 14, 10, 0, 0));
    poller.setFeed('mem-alex', 'https://calendar.google.com/calendar/ical/secret/basic.ics');
    const row = db.prepare('SELECT ical_url_sealed FROM member_calendar_feeds WHERE member_id = ?')
      .get('mem-alex') as { ical_url_sealed: string };
    expect(row.ical_url_sealed).not.toContain('calendar.google.com');
    const key = contextSecretKey();
    expect(key).toBeTruthy();
    expect(unsealString(row.ical_url_sealed, key!)).toContain('basic.ics');
    const upserted = await poller.poll();
    expect(upserted).toBe(1);
    const stored = db.prepare('SELECT title, location FROM calendar_events').get() as { title: string; location: string };
    expect(stored).toEqual({ title: 'Dinner', location: 'Jewel Changi' });
  });

  it('validates a Google iCal URL with one fetch then seals it', async () => {
    const poller = new CalendarPollService(db, (async () => new Response(ICS, { status: 200 })) as typeof fetch);
    const result = await poller.validateAndSet('mem-alex', 'https://calendar.google.com/calendar/ical/secret/basic.ics');
    expect(result).toEqual({ ok: true });
    expect(db.prepare('SELECT title FROM calendar_events').get()).toEqual({ title: 'Dinner' });
  });

  it('does not fetch when the flag is off', async () => {
    process.env.CONTEXT_CALENDAR = '';
    let called = 0;
    const poller = new CalendarPollService(db, (async () => {
      called += 1;
      return new Response(ICS, { status: 200 });
    }) as typeof fetch);
    poller.setFeed('mem-alex', 'https://calendar.google.com/calendar/ical/secret/basic.ics');
    expect(await poller.poll()).toBe(0);
    expect(called).toBe(0);
  });
});
