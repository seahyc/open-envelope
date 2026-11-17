import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/server/db/migrations.js';
import {
  AuthService,
  MAGIC_TTL_MS,
  parseSessionCookie,
  sessionCookie,
} from '../../src/server/services/auth-service.js';
import { DEFAULT_HOUSEHOLD_ID } from '../../src/server/lib/tenancy.js';
import { assertProductionAuthConfig, mapEmailToMember } from '../../src/server/lib/auth.js';
import { loadConfig } from '../../src/server/lib/config.js';
import { resolveCurrentMember } from '../../src/server/lib/member-identity.js';

describe('session auth + invites', () => {
  let db: Database.Database;
  let auth: AuthService;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, { quiet: true });
    auth = new AuthService(db);
  });

  it('issues a magic link that creates a user and session, and refuses a second consume', () => {
    const issued = auth.issueMagicLink('Alex@example.test', 'http://127.0.0.1:3100', true);
    expect(issued.captureUrl).toMatch(/token=/);
    const token = new URL(issued.captureUrl!).searchParams.get('token')!;
    const user = auth.consumeMagicLink(token);
    expect(user.email.toLowerCase()).toBe('alex@example.test');
    expect(user.householdId).toBeNull();
    const session = auth.createSession(user);
    const resolved = auth.resolveSession(session.token);
    expect(resolved?.id).toBe(user.id);
    expect(() => auth.consumeMagicLink(token)).toThrow(/napped/);
  });

  it('does not enumerate emails and rate-limits magic links', () => {
    const a = auth.issueMagicLink('nobody@example.test', 'http://x', false);
    const b = auth.issueMagicLink('nobody@example.test', 'http://x', true);
    expect(a.accepted).toBe(true);
    expect(b.accepted).toBe(true);
    auth.issueMagicLink('nobody@example.test', 'http://x', false);
    expect(() => auth.issueMagicLink('nobody@example.test', 'http://x', false)).toThrow(/minute/);
  });

  it('expires magic links', () => {
    const issued = auth.issueMagicLink('sam@example.test', 'http://x', true);
    const token = new URL(issued.captureUrl!).searchParams.get('token')!;
    db.prepare('UPDATE magic_link_tokens SET expires_at = ?').run(Date.now() - MAGIC_TTL_MS);
    expect(() => auth.consumeMagicLink(token)).toThrow(/napped/);
  });

  it('accepts an invite into P1 household with consent, and rejects email mismatch', () => {
    const p1 = auth.upsertUser('alex@example.test', 'Alex');
    auth.attachUserToDefaultHousehold(p1, 'Alex');
    const invite = auth.createInvite(DEFAULT_HOUSEHOLD_ID, null, 'sam@example.test');
    const peeked = auth.peekInvite(invite.token);
    expect(peeked.householdId).toBe(DEFAULT_HOUSEHOLD_ID);

    const p2 = auth.upsertUser('other@example.test', 'Other');
    expect(() => auth.acceptInvite(invite.token, p2, 'Sam', true)).toThrow(/doesn't work/);

    const sam = auth.upsertUser('sam@example.test', 'Sam');
    expect(() => auth.acceptInvite(invite.token, sam, 'Sam', false)).toThrow(/Consent/);
    const joined = auth.acceptInvite(invite.token, sam, 'Sam', true);
    expect(joined.householdId).toBe(DEFAULT_HOUSEHOLD_ID);
    const members = db.prepare(
      'SELECT name, email FROM household_members WHERE household_id = ? ORDER BY name'
    ).all(DEFAULT_HOUSEHOLD_ID);
    expect(members).toEqual([
      { name: 'Alex', email: 'alex@example.test' },
      { name: 'Sam', email: 'sam@example.test' },
    ]);
  });

  it('blocks a user who already belongs to another household', () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO households (id, name, currency, onboarding_step, created_at, updated_at) VALUES ('hh-2', 'Other', 'SGD', 'complete', ?, ?)"
    ).run(now, now);
    const user = auth.upsertUser('sam@example.test', 'Sam');
    db.prepare(
      "INSERT INTO household_members (id, household_id, name, email, user_id, created_at) VALUES ('m-x', 'hh-2', 'Sam', 'sam@example.test', ?, ?)"
    ).run(user.id, now);
    const invite = auth.createInvite(DEFAULT_HOUSEHOLD_ID, null, 'sam@example.test');
    expect(() => auth.acceptInvite(invite.token, { ...user, householdId: 'hh-2' }, 'Sam', true)).toThrow(
      /already in another/
    );
  });

  it('links Google subject to an email user', () => {
    const user = auth.linkGoogle('alex@example.test', 'sub-123', 'Alex Tan');
    expect(user.name).toBe('Alex Tan');
    const again = auth.linkGoogle('alex@example.test', 'sub-123', 'Alex Tan');
    expect(again.id).toBe(user.id);
  });

  it('writes a session cookie and parses it back', () => {
    const cookie = sessionCookie('tok', Date.now() + 60_000, false);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(parseSessionCookie(cookie)).toBe('tok');
    expect(parseSessionCookie(`${cookie}; other=1`)).toBe('tok');
  });

  it('lets session mode skip Access JWT in production unless ACCESS_GATE is on', () => {
    expect(() => assertProductionAuthConfig({ mode: 'session' }, 'production')).not.toThrow();
    expect(() =>
      assertProductionAuthConfig({ mode: 'session', accessGate: true }, 'production')
    ).toThrow(/ACCESS_GATE/);
  });

  it('maps ALLOWED_EMAILS onto existing hh-1 members without a new household', () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO household_members (id, household_id, name, email, created_at) VALUES ('m-alex', ?, 'Alex', 'alex@example.com', ?)",
    ).run(DEFAULT_HOUSEHOLD_ID, now);
    db.prepare(
      "INSERT INTO household_members (id, household_id, name, email, created_at) VALUES ('m-sam', ?, 'Sam', 'sam@example.com', ?)",
    ).run(DEFAULT_HOUSEHOLD_ID, now);
    const allowed = ['alex@example.com', 'sam@example.com'];
    expect(mapEmailToMember('alex@example.com', allowed)).toBe('alex');
    expect(mapEmailToMember('sam@example.com', allowed)).toBe('sam');
    expect(resolveCurrentMember(db, 'alex')).toMatchObject({ id: 'm-alex', name: 'Alex' });
    expect(resolveCurrentMember(db, 'sam')).toMatchObject({ id: 'm-sam', name: 'Sam' });
    expect(db.prepare('SELECT COUNT(*) as n FROM households').get()).toEqual({ n: 1 });
  });

  it('keeps Google and magic-link sign-up off unless AUTH_SIGNUP is on', () => {
    const previous = process.env.AUTH_SIGNUP;
    delete process.env.AUTH_SIGNUP;
    expect(loadConfig().authSignup).toBe(false);
    process.env.AUTH_SIGNUP = '1';
    expect(loadConfig().authSignup).toBe(true);
    if (previous === undefined) delete process.env.AUTH_SIGNUP;
    else process.env.AUTH_SIGNUP = previous;
  });
});
