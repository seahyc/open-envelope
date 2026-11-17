import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/server/db/migrations.js';
import { OnboardingService } from '../../src/server/services/onboarding-service.js';

describe('onboarding progress', () => {
  let db: Database.Database;
  let service: OnboardingService;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, { quiet: true });
    service = new OnboardingService(db);
  });

  it('saves and resumes wizard state without marking onboarded', () => {
    expect(service.isOnboarded()).toBe(false);
    service.saveProgress('invite', { name: 'Garden Budget', currency: 'SGD', budgetStartDate: '2026-10-01' });
    expect(service.isOnboarded()).toBe(false);
    const status = service.getStatus();
    expect(status.step).toBe('invite');
    expect(status.householdName).toBe('Garden Budget');
    expect(status.payload).toMatchObject({ currency: 'SGD' });
  });

  it('complete step onboarded the household', () => {
    service.saveProgress('complete', { name: 'Garden Budget' });
    expect(service.isOnboarded()).toBe(true);
    expect(service.getStatus().step).toBe('complete');
  });

  it('stores a typed zero starting balance and skips a blank one', async () => {
    await service.setupHousehold(
      [{ name: 'Alex', email: 'alex@example.test' }],
      [{
        name: 'Zero Cash',
        aliases: [],
        group: 'budget',
        startingBalanceCents: 0,
        startDate: Date.now(),
      }],
    );
    expect(
      (db.prepare("SELECT COUNT(*) as n FROM transactions WHERE merchant_text = 'Starting Balance'").get() as { n: number }).n,
    ).toBe(1);
    expect(
      (db.prepare("SELECT amount_cents as n FROM transactions WHERE merchant_text = 'Starting Balance'").get() as { n: number }).n,
    ).toBe(0);

    db = new Database(':memory:');
    runMigrations(db, { quiet: true });
    service = new OnboardingService(db);
    await service.setupHousehold(
      [{ name: 'Alex', email: 'alex@example.test' }],
      [{
        name: 'Unknown Cash',
        aliases: [],
        group: 'budget',
        startingBalanceCents: null,
        startDate: Date.now(),
      }],
    );
    expect(
      (db.prepare("SELECT COUNT(*) as n FROM transactions WHERE merchant_text = 'Starting Balance'").get() as { n: number }).n,
    ).toBe(0);
  });
});

