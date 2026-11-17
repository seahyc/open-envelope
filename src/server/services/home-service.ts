import type Database from 'better-sqlite3';
import { findCategory, loadCategorySchema, type CategorySchema } from '../categoriser/schema.js';
import { normalizeMerchantKey } from '../categoriser/normalize.js';
import { hh } from '../lib/tenancy.js';
import { displayMerchantName } from './display-name.js';

/** Outflows at or above this are treated as capital, not month-to-date spend. */
export const GLANCE_CAPITAL_MIN_CENTS = 10_000_000;
/** Same-day last-month comparison needs about a week of outflow days to be meaningful. */
export const LAST_MONTH_COMPARE_MIN_DAYS = 7;

export interface HomeGlance {
  asOf: number;
  budget: { exists: boolean; readyToAssignCents: number | null };
  reviewCount: number;
  spent: {
    thisMonthCents: number;
    lastMonthSameDayCents: number;
    deltaCents: number;
    hasLastMonthData: boolean;
    categorisedCents: number;
  };
  latestDataAt: number | null;
  topCategories: Array<{ label: string; spentCents: number; ratio: number }>;
  netWorth: { cents: number; knownAccountCount: number; missingAccountCount: number };
  accounts: Array<{
    id: string;
    name: string;
    group: string;
    balanceCents: number | null;
    asOf: number | null;
    needsStartingBalance: boolean;
  }>;
  recent: Array<{
    id: string;
    merchant: string;
    categoryId: string | null;
    categoryLabel: string | null;
    amountCents: number;
    timestamp: number;
  }>;
}

const GLANCE_TZ = 'Asia/Singapore';
const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;

export function singaporeYmd(ts: number): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-SG', {
    timeZone: GLANCE_TZ,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(new Date(ts));
  const num = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: num('year'), month: num('month'), day: num('day') };
}

function singaporeDateUtc(year: number, month: number, day: number, hour = 0, minute = 0, second = 0, ms = 0): number {
  return Date.UTC(year, month - 1, day, hour, minute, second, ms) - SGT_OFFSET_MS;
}

function monthKey(ts: number): string {
  const { year, month } = singaporeYmd(ts);
  return `${year}-${String(month).padStart(2, '0')}`;
}

function startOfMonth(ts: number): number {
  const { year, month } = singaporeYmd(ts);
  return singaporeDateUtc(year, month, 1);
}

function sameDayLastMonth(ts: number): { start: number; end: number } {
  const { year, month, day } = singaporeYmd(ts);
  const lastMonth = month === 1 ? 12 : month - 1;
  const lastYear = month === 1 ? year - 1 : year;
  const start = singaporeDateUtc(lastYear, lastMonth, 1);
  const clipped = Math.min(day, daysInMonth(lastYear, lastMonth));
  const end = singaporeDateUtc(lastYear, lastMonth, clipped, 23, 59, 59, 999);
  return { start, end };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export class HomeService {
  constructor(
    private db: Database.Database,
    private schema: CategorySchema = loadCategorySchema(),
    private readyToAssign: (month: string) => number,
  ) {}

  glance(asOf = Date.now()): HomeGlance {
    const month = monthKey(asOf);
    const budgetExists = (this.db.prepare(
      'SELECT COUNT(*) as count FROM budget_allocations WHERE household_id = ?'
    ).get(hh()) as { count: number }).count > 0;
    const reviewCount = (this.db.prepare(
      'SELECT COUNT(*) as count FROM review_queue WHERE household_id = ? AND resolved = 0'
    ).get(hh()) as { count: number }).count;

    const monthStart = startOfMonth(asOf);
    const categorisedCents = this.spentBetween(monthStart, asOf, { categorisedOnly: true });
    const rawOutflowCents = this.spentBetween(monthStart, asOf, { categorisedOnly: false });
    const thisMonthCents = rawOutflowCents;
    const lastWindow = sameDayLastMonth(asOf);
    const lastMonthSameDayCents = this.spentBetween(lastWindow.start, lastWindow.end, { categorisedOnly: false });
    const lastMonthDays = this.outflowDays(lastWindow.start, lastWindow.end);

    return {
      asOf,
      budget: {
        exists: budgetExists,
        readyToAssignCents: budgetExists ? this.readyToAssign(month) : null,
      },
      reviewCount,
      spent: {
        thisMonthCents,
        lastMonthSameDayCents,
        deltaCents: thisMonthCents - lastMonthSameDayCents,
        hasLastMonthData: lastMonthDays >= LAST_MONTH_COMPARE_MIN_DAYS,
        categorisedCents,
      },
      latestDataAt: this.latestTransactionAt(),
      topCategories: this.topCategories(monthStart, asOf, thisMonthCents),
      ...this.accounts(),
      recent: this.recent(),
    };
  }

  private spentBetween(
    start: number,
    end: number,
    options: { categorisedOnly: boolean }
  ): number {
    const categorised = options.categorisedOnly
      ? "AND category IS NOT NULL AND category NOT LIKE 'xfer.%' AND category NOT LIKE 'inc.%'"
      : "AND (category IS NULL OR (category NOT LIKE 'xfer.%' AND category NOT LIKE 'inc.%'))";
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(-amount_cents), 0) as total
      FROM transactions
      WHERE household_id = ?
        AND amount_cents < 0
        AND ABS(amount_cents) < ?
        AND timestamp >= ? AND timestamp <= ?
        ${categorised}
    `).get(hh(), GLANCE_CAPITAL_MIN_CENTS, start, end) as { total: number };
    return row.total;
  }

  private outflowDays(start: number, end: number): number {
    const row = this.db.prepare(`
      SELECT COUNT(DISTINCT date(timestamp / 1000, 'unixepoch', '+8 hours')) as days
      FROM transactions
      WHERE household_id = ?
        AND amount_cents < 0
        AND ABS(amount_cents) < ?
        AND timestamp >= ? AND timestamp <= ?
        AND (category IS NULL OR (category NOT LIKE 'xfer.%' AND category NOT LIKE 'inc.%'))
    `).get(hh(), GLANCE_CAPITAL_MIN_CENTS, start, end) as { days: number };
    return row.days;
  }

  private latestTransactionAt(): number | null {
    const row = this.db.prepare(`
      SELECT MAX(timestamp) as latest
      FROM transactions
      WHERE household_id = ?
    `).get(hh()) as { latest: number | null };
    return row.latest ?? null;
  }

  private topCategories(start: number, end: number, totalSpent: number) {
    const rows = this.db.prepare(`
      SELECT category, SUM(-amount_cents) as spent
      FROM transactions
      WHERE household_id = ?
        AND amount_cents < 0
        AND ABS(amount_cents) < ?
        AND timestamp >= ? AND timestamp <= ?
        AND category IS NOT NULL AND category NOT LIKE 'xfer.%' AND category NOT LIKE 'inc.%'
      GROUP BY category
      ORDER BY spent DESC
    `).all(hh(), GLANCE_CAPITAL_MIN_CENTS, start, end) as Array<{ category: string; spent: number }>;
    const buckets = new Map<string, number>();
    for (const row of rows) {
      const found = findCategory(this.schema, row.category);
      const label = found ? found.path.slice(0, 2).join(' ▸ ') : row.category;
      buckets.set(label, (buckets.get(label) ?? 0) + row.spent);
    }
    return [...buckets.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([label, spentCents]) => ({
        label,
        spentCents,
        ratio: totalSpent > 0 ? spentCents / totalSpent : 0,
      }));
  }

  private accounts(): Pick<HomeGlance, 'netWorth' | 'accounts'> {
    const accounts = this.db.prepare(
      'SELECT id, name, account_group FROM accounts WHERE household_id = ? ORDER BY name'
    ).all(hh()) as Array<{ id: string; name: string; account_group: string }>;
    const listed = accounts.map((account) => {
      const period = this.db.prepare(`
        SELECT closing_balance_cents, end_date
        FROM statement_periods
        WHERE household_id = ? AND account_id = ?
        ORDER BY end_date DESC
        LIMIT 1
      `).get(hh(), account.id) as { closing_balance_cents: number; end_date: number } | undefined;
      if (!period) {
        return {
          id: account.id,
          name: account.name,
          group: account.account_group,
          balanceCents: null as number | null,
          asOf: null as number | null,
          needsStartingBalance: true,
        };
      }
      return {
        id: account.id,
        name: account.name,
        group: account.account_group,
        balanceCents: period.closing_balance_cents,
        asOf: period.end_date,
        needsStartingBalance: false,
      };
    });
    let cents = 0;
    let known = 0;
    let missing = 0;
    for (const account of listed) {
      if (account.needsStartingBalance || account.balanceCents == null) {
        missing += 1;
        continue;
      }
      known += 1;
      cents += account.group === 'credit' ? -Math.abs(account.balanceCents) : account.balanceCents;
    }
    return {
      netWorth: { cents, knownAccountCount: known, missingAccountCount: missing },
      accounts: listed,
    };
  }

  private recent() {
    const rows = this.db.prepare(`
      SELECT id, merchant_text, category, amount_cents, timestamp
      FROM transactions
      WHERE household_id = ?
      ORDER BY timestamp DESC
      LIMIT 5
    `).all(hh()) as Array<{
      id: string;
      merchant_text: string;
      category: string | null;
      amount_cents: number;
      timestamp: number;
    }>;
    return rows.map((row) => {
      const found = row.category ? findCategory(this.schema, row.category) : undefined;
      const merchantKey = normalizeMerchantKey(row.merchant_text);
      const note = merchantKey
        ? this.db.prepare(
          'SELECT payee_label as payeeLabel FROM payee_notes WHERE household_id = ? AND merchant_key = ?'
        ).get(hh(), merchantKey) as { payeeLabel: string } | undefined
        : undefined;
      const enrich = merchantKey
        ? this.db.prepare(
          'SELECT registered_name as registeredName FROM merchant_enrichments WHERE merchant_key = ?'
        ).get(merchantKey) as { registeredName: string | null } | undefined
        : undefined;
      return {
        id: row.id,
        merchant: displayMerchantName({
          savedPayee: note?.payeeLabel ?? null,
          registeredName: enrich?.registeredName ?? null,
          merchantText: row.merchant_text,
        }),
        categoryId: row.category,
        categoryLabel: found ? found.path.join(' ▸ ') : null,
        amountCents: row.amount_cents,
        timestamp: row.timestamp,
      };
    });
  }
}
