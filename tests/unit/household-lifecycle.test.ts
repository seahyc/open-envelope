import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/server/db/migrations.js';
import { HouseholdService } from '../../src/server/services/household-service.js';
import { DEFAULT_HOUSEHOLD_ID, runWithHousehold } from '../../src/server/lib/tenancy.js';

describe('household export and delete', () => {
  let db: Database.Database;
  let service: HouseholdService;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, { quiet: true });
    service = new HouseholdService(db);
    const now = Date.now();
    db.prepare(
      "INSERT INTO households (id, name, currency, onboarding_step, created_at, updated_at) VALUES ('hh-2', 'Kopi Corner', 'SGD', 'complete', ?, ?)"
    ).run(now, now);
    db.prepare(
      "INSERT INTO accounts (id, household_id, name, aliases, account_group, created_at) VALUES ('acc-2', 'hh-2', 'Secret', '[]', 'budget', ?)"
    ).run(now);
    db.prepare(
      "INSERT INTO accounts (id, household_id, name, aliases, account_group, created_at) VALUES ('acc-1', 'hh-1', 'Ours', '[]', 'budget', ?)"
    ).run(now);
  });

  it('export lists only the current household rows', () => {
    const snap = service.exportSnapshot();
    expect(snap.householdId).toBe(DEFAULT_HOUSEHOLD_ID);
    const ids = (snap.tables.accounts as Array<{ id: string }>).map((row) => row.id);
    expect(ids).toEqual(['acc-1']);

    runWithHousehold('hh-2', () => {
      const other = service.exportSnapshot();
      expect(other.householdId).toBe('hh-2');
      expect((other.tables.accounts as Array<{ id: string }>).map((row) => row.id)).toEqual(['acc-2']);
    });
  });

  it('delete requires the household name and purges only that tenant', () => {
    expect(() => service.deleteCurrent('nope', 'selfhost')).toThrow(/name/i);
    runWithHousehold('hh-2', () => {
      service.deleteCurrent('Kopi Corner', 'selfhost');
    });
    expect(db.prepare("SELECT COUNT(*) as n FROM accounts WHERE household_id = 'hh-2'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) as n FROM accounts WHERE household_id = 'hh-1'").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT id FROM households WHERE id = 'hh-2'").get()).toBeUndefined();
  });

  it('onboarding reset deletes Connections rows that FK members and keeps hh-1', () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO household_members (id, household_id, name, email, created_at) VALUES ('m-alex', 'hh-1', 'Alex', 'alex@example.com', ?)",
    ).run(now);
    db.prepare(
      "INSERT INTO ingest_mailboxes (id, household_id, member_id, local_part, created_at) VALUES ('mb-1', 'hh-1', 'm-alex', 'alex', ?)",
    ).run(now);
    db.prepare(
      "INSERT INTO ingest_hooks (id, household_id, member_id, name, secret_enc, created_at) VALUES ('hk-1', 'hh-1', 'm-alex', 'Shortcuts', 'enc', ?)",
    ).run(now);
    db.prepare(
      "UPDATE households SET onboarding_step = 'complete', name = 'Garden' WHERE id = 'hh-1'",
    ).run();

    service.resetOnboarding();

    expect(db.prepare("SELECT COUNT(*) as n FROM household_members WHERE household_id = 'hh-1'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) as n FROM ingest_mailboxes WHERE household_id = 'hh-1'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) as n FROM ingest_hooks WHERE household_id = 'hh-1'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) as n FROM accounts WHERE household_id = 'hh-1'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) as n FROM accounts WHERE household_id = 'hh-2'").get()).toEqual({ n: 1 });
    const household = db.prepare(
      "SELECT id, name, onboarding_step FROM households WHERE id = 'hh-1'",
    ).get() as { id: string; name: string; onboarding_step: string };
    expect(household).toEqual({ id: 'hh-1', name: 'Household', onboarding_step: 'welcome' });
  });
});
