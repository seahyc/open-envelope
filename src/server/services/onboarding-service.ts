import type Database from 'better-sqlite3';
import crypto from 'crypto';
import { assertNotLLMSourced } from '../lib/llm-guards.js';
import { parseAliases } from '../lib/account-resolve.js';
import { hh } from '../lib/tenancy.js';

export interface HouseholdMember {
  name: string;
  email: string;
}

export interface AccountSetup {
  name: string;
  aliases: string[];
  group: 'budget' | 'credit' | 'tracking';
  startingBalanceCents: number | null;
  startDate: number;
}

export interface OnboardingStatus {
  onboarded: boolean;
  hasAccounts: boolean;
  hasTransactions: boolean;
  members: HouseholdMember[];
  step: string;
  payload: Record<string, unknown>;
  currency: string;
  householdName: string;
}

type AccountRow = { id: string; name: string; aliases: string };

const SHARED_ENVELOPES = ['Groceries', 'Rent', 'Utilities', 'Transportation', 'Entertainment'];

export class OnboardingService {
  constructor(private db: Database.Database) {}

  accountCount(): number {
    return (this.db.prepare('SELECT COUNT(*) as count FROM accounts WHERE household_id = ?').get(hh()) as { count: number }).count;
  }

  transactionCount(): number {
    return (this.db.prepare('SELECT COUNT(*) as count FROM transactions WHERE household_id = ?').get(hh()) as { count: number }).count;
  }

  memberCount(): number {
    return (this.db.prepare('SELECT COUNT(*) as count FROM household_members WHERE household_id = ?').get(hh()) as { count: number }).count;
  }

  listMembers(): HouseholdMember[] {
    return this.db.prepare(
      'SELECT name, COALESCE(email, \'\') as email FROM household_members WHERE household_id = ? ORDER BY created_at, name'
    ).all(hh()) as HouseholdMember[];
  }

  hasExistingHouseholdData(): boolean {
    return this.accountCount() > 0 || this.transactionCount() > 0;
  }

  householdRow(): { onboarding_step: string; onboarding_payload: string | null; name: string; currency: string } | undefined {
    return this.db.prepare(
      'SELECT onboarding_step, onboarding_payload, name, currency FROM households WHERE id = ?'
    ).get(hh()) as { onboarding_step: string; onboarding_payload: string | null; name: string; currency: string } | undefined;
  }

  isOnboarded(): boolean {
    const row = this.householdRow();
    if (row?.onboarding_step === 'complete') return true;
    if (row?.onboarding_step && row.onboarding_step !== 'welcome') return false;
    return this.hasExistingHouseholdData() || this.memberCount() > 0;
  }

  getStatus(): OnboardingStatus {
    const row = this.householdRow();
    let payload: Record<string, unknown> = {};
    if (row?.onboarding_payload) {
      try {
        payload = JSON.parse(row.onboarding_payload) as Record<string, unknown>;
      } catch {
        payload = {};
      }
    }
    return {
      onboarded: this.isOnboarded(),
      hasAccounts: this.accountCount() > 0,
      hasTransactions: this.transactionCount() > 0,
      members: this.listMembers(),
      step: row?.onboarding_step ?? 'welcome',
      payload,
      currency: row?.currency ?? 'SGD',
      householdName: row?.name ?? 'Household',
    };
  }

  saveProgress(step: string, payload: Record<string, unknown> = {}): void {
    const now = Date.now();
    const existing = this.householdRow();
    let previous: Record<string, unknown> = {};
    if (existing?.onboarding_payload) {
      try {
        previous = JSON.parse(existing.onboarding_payload) as Record<string, unknown>;
      } catch {
        previous = {};
      }
    }
    const merged = { ...previous, ...payload };
    const name = typeof merged.name === 'string' && merged.name.trim() ? merged.name.trim() : (existing?.name ?? 'Household');
    const currency = typeof merged.currency === 'string' && merged.currency ? merged.currency : (existing?.currency ?? 'SGD');
    const start = typeof merged.budgetStartDate === 'string' ? merged.budgetStartDate : null;
    this.db.prepare(`
      UPDATE households
      SET onboarding_step = ?, onboarding_payload = ?, name = ?, currency = ?,
          budget_start_date = COALESCE(?, budget_start_date), updated_at = ?
      WHERE id = ?
    `).run(step, JSON.stringify(merged), name, currency, start, now, hh());
  }

  upsertMembers(members: HouseholdMember[]): void {
    const now = Date.now();
    for (const member of members) {
      const name = member.name.trim();
      if (!name) continue;
      const email = (member.email || '').trim();

      const existing = this.db.prepare(
        'SELECT id FROM household_members WHERE household_id = ? AND lower(name) = lower(?)'
      ).get(hh(), name) as { id: string } | undefined;

      if (existing) {
        if (email) {
          this.db.prepare('UPDATE household_members SET email = ? WHERE id = ? AND household_id = ?').run(email, existing.id, hh());
        }
        continue;
      }

      this.db.prepare(
        'INSERT INTO household_members (id, household_id, name, email, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(crypto.randomBytes(8).toString('hex'), hh(), name, email || null, now);
    }
  }

  findCollidingAccount(account: AccountSetup): AccountRow | undefined {
    const accounts = this.db.prepare('SELECT id, name, aliases FROM accounts WHERE household_id = ?').all(hh()) as AccountRow[];
    const incomingAliases = new Set(
      [account.name, ...(account.aliases || [])].map((value) => value.trim().toLowerCase()).filter(Boolean)
    );

    for (const row of accounts) {
      const existing = [row.name, ...parseAliases(row.aliases)].map((value) => value.trim().toLowerCase());
      if (existing.some((alias) => incomingAliases.has(alias))) {
        return row;
      }
    }
    return undefined;
  }

  async setupHousehold(members: HouseholdMember[], accounts: AccountSetup[] = []): Promise<{ membersOnly: boolean }> {
    assertNotLLMSourced({ source: 'user' }, 'onboarding setup');
    this.upsertMembers(members);

    const existingData = this.hasExistingHouseholdData();
    if (existingData) {
      return { membersOnly: true };
    }

    const now = Date.now();

    for (const account of accounts) {
      if (!account.name?.trim()) continue;
      if (this.findCollidingAccount(account)) continue;

      const accountId = crypto.randomBytes(8).toString('hex');
      assertNotLLMSourced({ source: 'user' }, 'account INSERT');
      this.db.prepare(`
        INSERT INTO accounts (id, household_id, name, aliases, account_group, opened_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        accountId,
        hh(),
        account.name.trim(),
        JSON.stringify(account.aliases || []),
        account.group,
        account.startDate,
        now
      );

      if (account.startingBalanceCents !== null && account.startingBalanceCents !== undefined) {
        const txId = crypto.randomBytes(8).toString('hex');
        assertNotLLMSourced({ source: 'user' }, 'starting balance transaction INSERT');
        this.db.prepare(`
          INSERT INTO transactions (
            id, household_id, account_id, amount_cents, currency, timestamp,
            merchant_text, state, observation_ids, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          txId,
          hh(),
          accountId,
          account.startingBalanceCents,
          'USD',
          account.startDate,
          'Starting Balance',
          'reconciled',
          JSON.stringify([]),
          now,
          now
        );
      }
    }

    this.ensureDefaultEnvelopes(members, now);
    this.saveProgress('complete', {});
    return { membersOnly: false };
  }

  loadDemoData(): void {
    if (this.isOnboarded()) {
      return;
    }

    void this.setupHousehold(
      [
        { name: 'Alex', email: 'alex@example.com' },
        { name: 'Sam', email: 'sam@example.com' },
      ],
      [
        {
          name: 'Joint Checking',
          aliases: ['1234', 'checking'],
          group: 'budget',
          startingBalanceCents: 500000,
          startDate: new Date('2024-01-01').getTime(),
        },
        {
          name: 'Savings',
          aliases: ['5678', 'savings'],
          group: 'budget',
          startingBalanceCents: 1000000,
          startDate: new Date('2024-01-01').getTime(),
        },
      ]
    );
  }

  private ensureDefaultEnvelopes(members: HouseholdMember[], now: number): void {
    const existing = this.db.prepare('SELECT name, owner FROM envelopes WHERE household_id = ?').all(hh()) as Array<{ name: string; owner: string }>;
    const seen = new Set(existing.map((row) => `${row.owner.toLowerCase()}::${row.name.toLowerCase()}`));

    for (const name of SHARED_ENVELOPES) {
      const key = `shared::${name.toLowerCase()}`;
      if (seen.has(key)) continue;
      this.db.prepare('INSERT INTO envelopes (id, household_id, name, owner, created_at) VALUES (?, ?, ?, ?, ?)').run(
        crypto.randomBytes(8).toString('hex'),
        hh(),
        name,
        'shared',
        now
      );
      seen.add(key);
    }

    for (const member of members) {
      const name = member.name.trim();
      if (!name) continue;
      const envelopeName = `${name}'s Personal`;
      const key = `${name.toLowerCase()}::${envelopeName.toLowerCase()}`;
      if (seen.has(key)) continue;
      this.db.prepare('INSERT INTO envelopes (id, household_id, name, owner, created_at) VALUES (?, ?, ?, ?, ?)').run(
        crypto.randomBytes(8).toString('hex'),
        hh(),
        envelopeName,
        name.toLowerCase(),
        now
      );
      seen.add(key);
    }
  }
}
