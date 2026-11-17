import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/server/db/migrations.js';
import { emailForAccessIdentity } from '../../src/server/lib/auth.js';
import {
  provisionAccessMember,
  resolveCurrentMember,
  resolveOrProvisionAccessMember,
  seedLegacyAccessMembers,
} from '../../src/server/lib/member-identity.js';
import { DEFAULT_HOUSEHOLD_ID } from '../../src/server/lib/tenancy.js';
import { AuthService } from '../../src/server/services/auth-service.js';
import { CalendarPollService } from '../../src/server/services/context/calendar-poll.js';
import { ConnectionsService } from '../../src/server/services/context/connections-service.js';
import { HooksService } from '../../src/server/services/context/hooks-service.js';
import { LocationIngestService } from '../../src/server/services/context/location-ingest.js';
import { OnboardingService } from '../../src/server/services/onboarding-service.js';

const ALLOWED = ['ying.cong@example.com', 'partner@example.com'];

function legacyHouseholdZeroMembers(db: Database.Database): void {
  const now = Date.now();
  db.prepare(
    "UPDATE households SET name = 'Household', onboarding_step = 'complete', onboarding_payload = NULL WHERE id = ?",
  ).run(DEFAULT_HOUSEHOLD_ID);
  db.prepare(`
    INSERT INTO accounts (id, household_id, name, aliases, account_group, created_at)
    VALUES ('acct-legacy', ?, 'Joint Checking', '[]', 'budget', ?)
  `).run(DEFAULT_HOUSEHOLD_ID, now);
  db.prepare('DELETE FROM household_members WHERE household_id = ?').run(DEFAULT_HOUSEHOLD_ID);
}

describe('legacy hh-1 with zero household_members', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, { quiet: true });
    legacyHouseholdZeroMembers(db);
  });

  it('maps allowlist identities onto emails and refuses everyone else', () => {
    expect(emailForAccessIdentity('alex', ALLOWED)).toBe(ALLOWED[0]);
    expect(emailForAccessIdentity('sam', ALLOWED)).toBe(ALLOWED[1]);
    expect(emailForAccessIdentity(ALLOWED[0], ALLOWED)).toBe(ALLOWED[0]);
    expect(emailForAccessIdentity('stranger@evil.example', ALLOWED)).toBeNull();
    expect(emailForAccessIdentity('anonymous', ALLOWED)).toBeNull();
  });

  it('seeds owner+partner from ALLOWED_EMAILS without a new household', () => {
    const created = seedLegacyAccessMembers(db, ALLOWED);
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({
      id: 'alex',
      email: ALLOWED[0],
      name: 'ying.cong',
    });
    expect(created[1]).toMatchObject({
      id: 'sam',
      email: ALLOWED[1],
      name: 'partner',
    });
    const roles = db.prepare(
      'SELECT id, role FROM household_members WHERE household_id = ? ORDER BY created_at',
    ).all(DEFAULT_HOUSEHOLD_ID);
    expect(roles).toEqual([
      { id: 'alex', role: 'owner' },
      { id: 'sam', role: 'partner' },
    ]);
    expect(db.prepare('SELECT COUNT(*) as n FROM households').get()).toEqual({ n: 1 });
    expect(seedLegacyAccessMembers(db, ALLOWED)).toHaveLength(2);
    expect(db.prepare('SELECT COUNT(*) as n FROM household_members').get()).toEqual({ n: 2 });
  });

  it('uses onboarding payload / LOCATION_DEVICES names when present', () => {
    db.prepare(
      "UPDATE households SET onboarding_payload = ? WHERE id = ?",
    ).run(JSON.stringify({ you: 'Alex', partner: 'Sam Tan' }), DEFAULT_HOUSEHOLD_ID);
    const named = seedLegacyAccessMembers(db, ALLOWED);
    expect(named[0].name).toBe('Alex');
    expect(named[1].name).toBe('Sam Tan');

    db.prepare('DELETE FROM household_members').run();
    db.prepare("UPDATE households SET onboarding_payload = NULL WHERE id = ?").run(DEFAULT_HOUSEHOLD_ID);
    const fromEnv = seedLegacyAccessMembers(db, ALLOWED, {
      env: { LOCATION_DEVICES: 'phone:alex:secret,watch:sam:secret' },
    });
    expect(fromEnv[0].name).toBe('Alex');
    expect(fromEnv[1].name).toBe('Sam');
  });

  it('whoami resolves both allowlisted identities after seed', () => {
    seedLegacyAccessMembers(db, ALLOWED);
    const alex = resolveOrProvisionAccessMember(db, 'alex', {
      allowedEmails: ALLOWED,
      lazyCreate: true,
    });
    const sam = resolveOrProvisionAccessMember(db, 'sam', {
      allowedEmails: ALLOWED,
      lazyCreate: true,
    });
    expect(alex).toMatchObject({ id: 'alex', email: ALLOWED[0], name: 'ying.cong' });
    expect(sam).toMatchObject({ id: 'sam', email: ALLOWED[1], name: 'partner' });
    expect(resolveCurrentMember(db, 'alex', { allowedEmails: ALLOWED })?.id).toBe('alex');
    expect(new OnboardingService(db).isOnboarded()).toBe(true);
  });

  it('lazily creates only the current allowlisted identity', () => {
    const alex = resolveOrProvisionAccessMember(db, 'alex', {
      allowedEmails: ALLOWED,
      lazyCreate: true,
    });
    expect(alex).toMatchObject({ id: 'alex', email: ALLOWED[0] });
    expect(db.prepare('SELECT COUNT(*) as n FROM household_members').get()).toEqual({ n: 1 });
    const sam = resolveOrProvisionAccessMember(db, 'sam', {
      allowedEmails: ALLOWED,
      lazyCreate: true,
    });
    expect(sam).toMatchObject({ id: 'sam', email: ALLOWED[1] });
    expect(db.prepare('SELECT COUNT(*) as n FROM household_members').get()).toEqual({ n: 2 });
  });

  it('never creates a member for an email outside ALLOWED_EMAILS', () => {
    expect(provisionAccessMember(db, 'stranger@evil.example', {
      allowedEmails: ALLOWED,
    })).toBeNull();
    expect(resolveOrProvisionAccessMember(db, 'stranger@evil.example', {
      allowedEmails: ALLOWED,
      lazyCreate: true,
    })).toBeNull();
    expect(db.prepare('SELECT COUNT(*) as n FROM household_members').get()).toEqual({ n: 0 });
  });

  it('does not provision when a second household exists', () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO households (id, name, currency, onboarding_step, created_at, updated_at) VALUES ('hh-2', 'Other', 'SGD', 'complete', ?, ?)",
    ).run(now, now);
    expect(provisionAccessMember(db, 'alex', { allowedEmails: ALLOWED })).toBeNull();
    expect(db.prepare('SELECT COUNT(*) as n FROM household_members').get()).toEqual({ n: 0 });
  });

  it('records invited_by_member_id on invites and connections/hooks key off that member', () => {
    seedLegacyAccessMembers(db, ALLOWED);
    const alex = resolveCurrentMember(db, 'alex', { allowedEmails: ALLOWED })!;
    const auth = new AuthService(db);
    const invite = auth.createInvite(DEFAULT_HOUSEHOLD_ID, alex.id, 'friend@example.com');
    const row = db.prepare(
      'SELECT invited_by_member_id, email FROM household_invites WHERE household_id = ?',
    ).get(DEFAULT_HOUSEHOLD_ID) as { invited_by_member_id: string; email: string };
    expect(row.invited_by_member_id).toBe('alex');
    expect(row.email).toBe('friend@example.com');
    const peeked = auth.peekInvite(invite.token);
    expect(peeked.householdId).toBe(DEFAULT_HOUSEHOLD_ID);

    const calendar = new CalendarPollService(db);
    const location = new LocationIngestService(db);
    const connections = new ConnectionsService(db, calendar, location);
    const snap = connections.snapshot('alex', 'https://app.example.test');
    expect(snap?.member.id).toBe('alex');
    expect(snap?.sources).toHaveLength(5);

    const hooks = new HooksService(db);
    const minted = hooks.mint(alex.id, 'Shortcuts', 'https://app.example.test');
    expect(minted.url).toContain('/api/hooks/');
    const stored = db.prepare(
      'SELECT member_id, household_id FROM ingest_hooks WHERE id = ?',
    ).get(minted.id) as { member_id: string; household_id: string };
    expect(stored).toEqual({ member_id: 'alex', household_id: DEFAULT_HOUSEHOLD_ID });
  });

  it('lets OwnTracks env bind to the seeded member id even when the display name is the email local part', () => {
    seedLegacyAccessMembers(db, ALLOWED);
    const location = new LocationIngestService(db);
    location.bootstrapFromEnv({ LOCATION_DEVICES: 'phone:alex:s3cret' });
    const device = db.prepare(
      'SELECT member_id FROM location_devices WHERE id = ?',
    ).get('phone') as { member_id: string } | undefined;
    expect(device?.member_id).toBe('alex');
  });
});
