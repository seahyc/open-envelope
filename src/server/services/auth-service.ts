import type Database from 'better-sqlite3';
import crypto from 'crypto';
import { DEFAULT_HOUSEHOLD_ID } from '../lib/tenancy.js';

export const SESSION_COOKIE = 'oe_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAGIC_TTL_MS = 15 * 60 * 1000;
export const INVITE_TTL_MS = 48 * 60 * 60 * 1000;

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  householdId: string | null;
}

export interface MagicLinkResult {
  accepted: true;
  captureUrl?: string;
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export class AuthService {
  constructor(private db: Database.Database) {}

  findUserByEmail(email: string): AuthUser | null {
    const row = this.db.prepare(
      `SELECT u.id, u.email, u.name,
              (SELECT household_id FROM household_members WHERE user_id = u.id AND household_id IS NOT NULL LIMIT 1) as household_id
       FROM users u WHERE lower(u.email) = lower(?)`
    ).get(email) as { id: string; email: string; name: string | null; household_id: string | null } | undefined;
    if (!row) return null;
    return { id: row.id, email: row.email, name: row.name, householdId: row.household_id };
  }

  upsertUser(email: string, name?: string | null): AuthUser {
    const existing = this.findUserByEmail(email);
    if (existing) {
      if (name && !existing.name) {
        this.db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, existing.id);
        return { ...existing, name };
      }
      return existing;
    }
    const id = crypto.randomBytes(8).toString('hex');
    const now = Date.now();
    this.db.prepare('INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)').run(
      id,
      email.trim(),
      name?.trim() || null,
      now
    );
    return { id, email: email.trim(), name: name?.trim() || null, householdId: null };
  }

  issueMagicLink(email: string, origin: string, capture: boolean): MagicLinkResult {
    const normalized = email.trim().toLowerCase();
    if (!normalized || !normalized.includes('@')) {
      throw new Error('Enter an email address');
    }
    const now = Date.now();
    const recent = this.db.prepare(
      `SELECT COUNT(*) as n FROM magic_link_tokens
       WHERE lower(email) = ? AND created_at > ?`
    ).get(normalized, now - 30_000) as { n: number };
    if (recent.n >= 3) {
      throw new Error('Easy. Try again in a minute.');
    }
    const token = randomToken();
    this.db.prepare(`
      INSERT INTO magic_link_tokens (id, email, token_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(crypto.randomBytes(8).toString('hex'), normalized, hashToken(token), now + MAGIC_TTL_MS, now);
    const captureUrl = `${origin.replace(/\/$/, '')}/api/auth/magic-link/consume?token=${encodeURIComponent(token)}`;
    return capture ? { accepted: true, captureUrl } : { accepted: true };
  }

  consumeMagicLink(token: string): AuthUser {
    const now = Date.now();
    const row = this.db.prepare(
      `SELECT id, email, expires_at, consumed_at FROM magic_link_tokens WHERE token_hash = ?`
    ).get(hashToken(token)) as { id: string; email: string; expires_at: number; consumed_at: number | null } | undefined;
    if (!row || row.consumed_at || row.expires_at < now) {
      throw new Error('That link already napped.');
    }
    this.db.prepare('UPDATE magic_link_tokens SET consumed_at = ? WHERE id = ?').run(now, row.id);
    return this.upsertUser(row.email);
  }

  createSession(user: AuthUser): { token: string; expiresAt: number } {
    const token = randomToken();
    const now = Date.now();
    const expiresAt = now + SESSION_TTL_MS;
    this.db.prepare(`
      INSERT INTO sessions (id, user_id, household_id, token_hash, expires_at, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomBytes(8).toString('hex'),
      user.id,
      user.householdId,
      hashToken(token),
      expiresAt,
      now,
      now
    );
    return { token, expiresAt };
  }

  resolveSession(token: string | undefined | null): AuthUser | null {
    if (!token) return null;
    const now = Date.now();
    const row = this.db.prepare(`
      SELECT s.id, s.expires_at, s.household_id, u.id as user_id, u.email, u.name
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?
    `).get(hashToken(token)) as {
      id: string;
      expires_at: number;
      household_id: string | null;
      user_id: string;
      email: string;
      name: string | null;
    } | undefined;
    if (!row || row.expires_at < now) return null;
    this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now, row.id);
    const membership = this.db.prepare(
      'SELECT household_id FROM household_members WHERE user_id = ? LIMIT 1'
    ).get(row.user_id) as { household_id: string } | undefined;
    const householdId = membership?.household_id ?? row.household_id;
    if (householdId && householdId !== row.household_id) {
      this.db.prepare('UPDATE sessions SET household_id = ? WHERE id = ?').run(householdId, row.id);
    }
    return { id: row.user_id, email: row.email, name: row.name, householdId: householdId ?? null };
  }

  deleteSession(token: string | undefined | null): void {
    if (!token) return;
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  }

  linkGoogle(email: string, subject: string, name?: string | null): AuthUser {
    const user = this.upsertUser(email, name);
    const existing = this.db.prepare(
      'SELECT id FROM oauth_accounts WHERE provider = ? AND provider_subject = ?'
    ).get('google', subject) as { id: string } | undefined;
    if (!existing) {
      this.db.prepare(`
        INSERT INTO oauth_accounts (id, user_id, provider, provider_subject, created_at)
        VALUES (?, ?, 'google', ?, ?)
      `).run(crypto.randomBytes(8).toString('hex'), user.id, subject, Date.now());
    }
    return this.findUserByEmail(email) ?? user;
  }

  createInvite(householdId: string, invitedByMemberId: string | null, email?: string | null): { token: string; expiresAt: number } {
    this.db.prepare(
      'UPDATE household_invites SET expires_at = ? WHERE household_id = ? AND accepted_at IS NULL AND declined_at IS NULL AND expires_at > ?'
    ).run(Date.now() - 1, householdId, Date.now());
    const token = randomToken();
    const now = Date.now();
    const expiresAt = now + INVITE_TTL_MS;
    this.db.prepare(`
      INSERT INTO household_invites (
        id, household_id, email, token_hash, invited_by_member_id, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomBytes(8).toString('hex'),
      householdId,
      email?.trim().toLowerCase() || null,
      hashToken(token),
      invitedByMemberId,
      expiresAt,
      now
    );
    return { token, expiresAt };
  }

  peekInvite(token: string): { householdId: string; householdName: string; email: string | null } {
    const now = Date.now();
    const row = this.db.prepare(`
      SELECT i.household_id, i.email, i.expires_at, i.accepted_at, i.declined_at, h.name
      FROM household_invites i JOIN households h ON h.id = i.household_id
      WHERE i.token_hash = ?
    `).get(hashToken(token)) as {
      household_id: string;
      email: string | null;
      expires_at: number;
      accepted_at: number | null;
      declined_at: number | null;
      name: string;
    } | undefined;
    if (!row || row.accepted_at || row.declined_at || row.expires_at < now) {
      throw new Error("This invite doesn't work.");
    }
    return { householdId: row.household_id, householdName: row.name, email: row.email };
  }

  acceptInvite(token: string, user: AuthUser, displayName: string, consent: boolean): AuthUser {
    if (!consent) throw new Error('Consent is required to join.');
    const invite = this.peekInvite(token);
    if (invite.email && invite.email.toLowerCase() !== user.email.toLowerCase()) {
      throw new Error("This invite doesn't work.");
    }
    const existingMembership = this.db.prepare(
      'SELECT household_id FROM household_members WHERE user_id = ? LIMIT 1'
    ).get(user.id) as { household_id: string } | undefined;
    if (existingMembership && existingMembership.household_id !== invite.householdId) {
      throw new Error("You're already in another household.");
    }
    const now = Date.now();
    this.db.prepare(
      'UPDATE household_invites SET accepted_at = ? WHERE token_hash = ?'
    ).run(now, hashToken(token));
    const name = displayName.trim() || user.name || user.email.split('@')[0] || 'Partner';
    const member = this.db.prepare(
      'SELECT id FROM household_members WHERE household_id = ? AND user_id = ?'
    ).get(invite.householdId, user.id) as { id: string } | undefined;
    if (!member) {
      const byName = this.db.prepare(
        'SELECT id FROM household_members WHERE household_id = ? AND lower(name) = lower(?)'
      ).get(invite.householdId, name) as { id: string } | undefined;
      if (byName) {
        this.db.prepare('UPDATE household_members SET user_id = ?, email = ? WHERE id = ?').run(
          user.id,
          user.email,
          byName.id
        );
      } else {
        this.db.prepare(`
          INSERT INTO household_members (id, household_id, name, email, user_id, role, created_at)
          VALUES (?, ?, ?, ?, ?, 'partner', ?)
        `).run(crypto.randomBytes(8).toString('hex'), invite.householdId, name, user.email, user.id, now);
      }
    }
    this.db.prepare('UPDATE sessions SET household_id = ? WHERE user_id = ?').run(invite.householdId, user.id);
    return { ...user, name, householdId: invite.householdId };
  }

  declineInvite(token: string): void {
    this.peekInvite(token);
    this.db.prepare(
      'UPDATE household_invites SET declined_at = ? WHERE token_hash = ?'
    ).run(Date.now(), hashToken(token));
  }

  attachUserToDefaultHousehold(user: AuthUser, memberName: string): AuthUser {
    const now = Date.now();
    const existing = this.db.prepare(
      'SELECT id FROM household_members WHERE household_id = ? AND user_id = ?'
    ).get(DEFAULT_HOUSEHOLD_ID, user.id) as { id: string } | undefined;
    if (!existing) {
      this.db.prepare(`
        INSERT INTO household_members (id, household_id, name, email, user_id, role, created_at)
        VALUES (?, ?, ?, ?, ?, 'partner', ?)
      `).run(
        crypto.randomBytes(8).toString('hex'),
        DEFAULT_HOUSEHOLD_ID,
        memberName,
        user.email,
        user.id,
        now
      );
    }
    this.db.prepare('UPDATE sessions SET household_id = ? WHERE user_id = ?').run(DEFAULT_HOUSEHOLD_ID, user.id);
    return { ...user, householdId: DEFAULT_HOUSEHOLD_ID };
  }
}

export function parseSessionCookie(header: string | undefined): string | null {
  if (!header) return null;
  const parts = header.split(';');
  for (const part of parts) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function sessionCookie(token: string, expiresAt: number, secure: boolean): string {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  const pieces = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secure) pieces.push('Secure');
  return pieces.join('; ');
}

export function clearSessionCookie(secure: boolean): string {
  const pieces = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) pieces.push('Secure');
  return pieces.join('; ');
}
