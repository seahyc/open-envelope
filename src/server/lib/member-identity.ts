import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { emailForAccessIdentity, mapEmailToMember } from './auth.js';
import { DEFAULT_HOUSEHOLD_ID, hh } from './tenancy.js';

export interface MemberRow {
  id: string;
  name: string;
  email: string;
}

export interface AccessMemberOptions {
  allowedEmails?: string[];
  lazyCreate?: boolean;
  env?: NodeJS.ProcessEnv;
}

export function slugFromName(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24);
  return slug || 'member';
}

function listMembers(db: Database.Database, householdId: string): MemberRow[] {
  return db.prepare(
    `SELECT id, name, COALESCE(email, '') as email
     FROM household_members
     WHERE household_id = ?
     ORDER BY created_at, name`,
  ).all(householdId) as MemberRow[];
}

function matchMember(members: MemberRow[], authUser: string, allowedEmails: string[]): MemberRow | null {
  const needle = authUser.trim().toLowerCase();
  if (!needle) return null;
  const byId = members.find((row) => row.id.toLowerCase() === needle);
  if (byId) return byId;
  const byName = members.find((row) => row.name.toLowerCase() === needle);
  if (byName) return byName;
  const byEmail = members.find((row) => row.email.toLowerCase() === needle);
  if (byEmail) return byEmail;
  const bySlug = members.find((row) => slugFromName(row.name) === needle);
  if (bySlug) return bySlug;
  const allowedEmail = emailForAccessIdentity(authUser, allowedEmails);
  if (allowedEmail) {
    const byAllowed = members.find((row) => row.email.toLowerCase() === allowedEmail.toLowerCase());
    if (byAllowed) return byAllowed;
  }
  return null;
}

export function resolveCurrentMember(
  db: Database.Database,
  authUser: string | undefined | null,
  options: AccessMemberOptions = {},
): MemberRow | null {
  const householdId = hh();
  const members = listMembers(db, householdId);
  if (members.length === 0) return null;
  if (!authUser || authUser === 'anonymous') return members[0] ?? null;
  const matched = matchMember(members, authUser, options.allowedEmails ?? []);
  if (matched) return matched;
  return members[0] ?? null;
}

/**
 * Header/Access whoami: resolve the member, creating a hh-1 row for an
 * allowlisted identity when this is the only household and none matches.
 */
export function resolveOrProvisionAccessMember(
  db: Database.Database,
  authUser: string | undefined | null,
  options: AccessMemberOptions = {},
): MemberRow | null {
  const allowedEmails = options.allowedEmails ?? [];
  const householdId = hh();
  const members = listMembers(db, householdId);
  if (!authUser || authUser === 'anonymous') {
    return members[0] ?? null;
  }
  const matched = matchMember(members, authUser, allowedEmails);
  if (matched) return matched;
  if (!options.lazyCreate) {
    return members[0] ?? null;
  }
  return provisionAccessMember(db, authUser, {
    ...options,
    allowedEmails,
  });
}

export function householdIdForMember(db: Database.Database, memberId: string): string | null {
  const row = db.prepare('SELECT household_id FROM household_members WHERE id = ?').get(memberId) as
    | { household_id: string }
    | undefined;
  return row?.household_id ?? null;
}

function memberCount(db: Database.Database, householdId: string): number {
  return (db.prepare(
    'SELECT COUNT(*) as n FROM household_members WHERE household_id = ?',
  ).get(householdId) as { n: number }).n;
}

function householdExists(db: Database.Database, householdId: string): boolean {
  const row = db.prepare(
    'SELECT id FROM households WHERE id = ? AND deleted_at IS NULL',
  ).get(householdId) as { id: string } | undefined;
  return Boolean(row);
}

function isSingleHousehold(db: Database.Database): boolean {
  const n = (db.prepare(
    'SELECT COUNT(*) as n FROM households WHERE deleted_at IS NULL',
  ).get() as { n: number }).n;
  return n === 1;
}

function localPart(email: string): string {
  const part = email.split('@')[0]?.trim();
  return part || 'member';
}

function titleCaseSlug(slug: string): string {
  const cleaned = slug.replace(/[._-]+/g, ' ').trim();
  if (!cleaned) return slug;
  return cleaned.replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function uniqueName(db: Database.Database, householdId: string, desired: string): string {
  const base = desired.trim() || 'member';
  const existing = db.prepare(
    'SELECT 1 as ok FROM household_members WHERE household_id = ? AND lower(name) = lower(?)',
  ).get(householdId, base) as { ok: number } | undefined;
  if (!existing) return base;
  let i = 2;
  while (true) {
    const candidate = `${base} ${i}`;
    const hit = db.prepare(
      'SELECT 1 as ok FROM household_members WHERE household_id = ? AND lower(name) = lower(?)',
    ).get(householdId, candidate) as { ok: number } | undefined;
    if (!hit) return candidate;
    i += 1;
  }
}

function uniqueId(db: Database.Database, desired: string): string {
  const base = desired.trim() || crypto.randomBytes(8).toString('hex');
  const existing = db.prepare('SELECT 1 as ok FROM household_members WHERE id = ?').get(base) as
    | { ok: number }
    | undefined;
  if (!existing) return base;
  return `${base}-${crypto.randomBytes(4).toString('hex')}`;
}

function payloadDisplayNames(db: Database.Database, householdId: string): {
  byEmail: Map<string, string>;
  you?: string;
  partner?: string;
} {
  const byEmail = new Map<string, string>();
  const row = db.prepare(
    'SELECT onboarding_payload FROM households WHERE id = ?',
  ).get(householdId) as { onboarding_payload: string | null } | undefined;
  if (!row?.onboarding_payload) return { byEmail };
  try {
    const payload = JSON.parse(row.onboarding_payload) as Record<string, unknown>;
    const you = typeof payload.you === 'string' ? payload.you.trim() : '';
    const partner = typeof payload.partner === 'string' ? payload.partner.trim() : '';
    const members = Array.isArray(payload.members) ? payload.members : [];
    for (const member of members) {
      if (!member || typeof member !== 'object') continue;
      const rec = member as { name?: unknown; email?: unknown };
      const email = typeof rec.email === 'string' ? rec.email.trim().toLowerCase() : '';
      const name = typeof rec.name === 'string' ? rec.name.trim() : '';
      if (email && name) byEmail.set(email, name);
    }
    return { byEmail, you: you || undefined, partner: partner || undefined };
  } catch {
    return { byEmail };
  }
}

function envSlotNames(env: NodeJS.ProcessEnv): { first?: string; second?: string } {
  const names: { first?: string; second?: string } = {};
  const devices = env.LOCATION_DEVICES || '';
  for (const part of devices.split(',').map((item) => item.trim()).filter(Boolean)) {
    const slug = part.split(':')[1]?.trim();
    if (!slug) continue;
    if (slug.toLowerCase() === 'alex' && !names.first) names.first = titleCaseSlug(slug);
    else if (slug.toLowerCase() === 'sam' && !names.second) names.second = titleCaseSlug(slug);
  }
  const calendars = env.CALENDAR_ICAL_URLS || '';
  for (const part of calendars.split(',').map((item) => item.trim()).filter(Boolean)) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const slug = part.slice(0, eq).trim();
    if (slug.toLowerCase() === 'alex' && !names.first) names.first = titleCaseSlug(slug);
    if (slug.toLowerCase() === 'sam' && !names.second) names.second = titleCaseSlug(slug);
  }
  return names;
}

function displayNameFor(
  db: Database.Database,
  householdId: string,
  email: string,
  index: number,
  env: NodeJS.ProcessEnv,
): string {
  const payload = payloadDisplayNames(db, householdId);
  const fromEmail = payload.byEmail.get(email.toLowerCase());
  if (fromEmail) return fromEmail;
  if (index === 0 && payload.you) return payload.you;
  if (index === 1 && payload.partner) return payload.partner;
  const slots = envSlotNames(env);
  if (index === 0 && slots.first) return slots.first;
  if (index === 1 && slots.second) return slots.second;
  return localPart(email);
}

function stableMemberId(email: string, allowedEmails: string[]): string {
  const mapped = mapEmailToMember(email, allowedEmails);
  if (mapped === 'alex' || mapped === 'sam') return mapped;
  return slugFromName(localPart(email));
}

function insertMember(
  db: Database.Database,
  householdId: string,
  id: string,
  name: string,
  email: string,
  role: 'owner' | 'partner',
): MemberRow {
  const now = Date.now();
  db.prepare(`
    INSERT INTO household_members (id, household_id, name, email, role, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, householdId, name, email, role, now);
  return { id, name, email };
}

/**
 * Idempotent boot step for a legacy self-host household that never had
 * `household_members` rows. Seeds hh-1 from ALLOWED_EMAILS only.
 */
export function seedLegacyAccessMembers(
  db: Database.Database,
  allowedEmails: string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): MemberRow[] {
  const emails = allowedEmails.map((email) => email.trim()).filter(Boolean);
  if (emails.length === 0) return [];
  if (!householdExists(db, DEFAULT_HOUSEHOLD_ID)) return [];
  if (memberCount(db, DEFAULT_HOUSEHOLD_ID) > 0) return listMembers(db, DEFAULT_HOUSEHOLD_ID);
  const env = options.env ?? process.env;
  const created: MemberRow[] = [];
  const insert = db.transaction(() => {
    for (const [i, email] of emails.entries()) {
      const id = uniqueId(db, stableMemberId(email, emails));
      const name = uniqueName(db, DEFAULT_HOUSEHOLD_ID, displayNameFor(db, DEFAULT_HOUSEHOLD_ID, email, i, env));
      const role = i === 0 ? 'owner' : 'partner';
      created.push(insertMember(db, DEFAULT_HOUSEHOLD_ID, id, name, email, role));
    }
  });
  insert();
  return created;
}

export function provisionAccessMember(
  db: Database.Database,
  identity: string | undefined | null,
  options: AccessMemberOptions = {},
): MemberRow | null {
  const allowedEmails = (options.allowedEmails ?? []).map((email) => email.trim()).filter(Boolean);
  if (!identity) return null;
  const email = emailForAccessIdentity(identity, allowedEmails);
  if (!email) return null;
  const householdId = hh() || DEFAULT_HOUSEHOLD_ID;
  if (householdId !== DEFAULT_HOUSEHOLD_ID) return null;
  if (!householdExists(db, householdId)) return null;
  if (!isSingleHousehold(db)) return null;

  const members = listMembers(db, householdId);
  const existing = matchMember(members, identity, allowedEmails);
  if (existing) return existing;

  const index = allowedEmails.indexOf(email);
  const env = options.env ?? process.env;
  const id = uniqueId(db, stableMemberId(email, allowedEmails));
  const name = uniqueName(db, householdId, displayNameFor(db, householdId, email, index < 0 ? 0 : index, env));
  const role = index === 0 ? 'owner' : 'partner';
  return insertMember(db, householdId, id, name, email, role);
}
