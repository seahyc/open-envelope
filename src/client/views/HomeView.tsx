import { useEffect, useState } from 'react';
import { api, ApiClientError } from '../api';
import { formatListDate, formatSgd, formatSignedSgd } from '../format';
import { Penny } from '../components/Penny';
import { BracketBar } from '../components/BracketBar';
import { PixelIcon, categoryIconName } from '../components/PixelIcon';

interface HomeGlance {
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

interface HomeViewProps {
  onReview: () => void;
  onBudget: () => void;
}

export function HomeView({ onReview, onBudget }: HomeViewProps) {
  const [glance, setGlance] = useState<HomeGlance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), 300);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setError(null);
      try {
        const data = await api<HomeGlance>('/api/home');
        if (cancelled) return;
        setGlance(data);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiClientError && err.kind === 'session') return;
        setError(err instanceof Error ? err.message : 'Could not load home');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="error-card" role="alert" data-testid="home-error">
        ✕ {error}
        <div>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              setLoading(true);
              setError(null);
              setGlance(null);
              void api<HomeGlance>('/api/home')
                .then((data) => setGlance(data))
                .catch((err) => {
                  if (err instanceof ApiClientError && err.kind === 'session') return;
                  setError(err instanceof Error ? err.message : 'Could not load home');
                })
                .finally(() => setLoading(false));
            }}
          >
            retry
          </button>
        </div>
      </div>
    );
  }

  if (loading || glance === null) {
    return slow ? <div className="skeleton" role="status">░░░░░░░░░░░░░░░░░░░░</div> : null;
  }

  const rta = glance.budget.exists ? glance.budget.readyToAssignCents : null;
  const reviewCount = glance.reviewCount;
  const allClear = reviewCount === 0 && glance.budget.exists && rta === 0;
  const funded = rta != null && rta <= 0 ? 1 : 0.61;
  const caption = reviewCount > 0
    ? `${reviewCount} things look odd to Penny.`
    : !glance.budget.exists
      ? 'Set up a budget when you are ready. Penny is waiting.'
      : rta != null && rta > 0
        ? `Penny is hungry. ${formatSgd(rta)} to assign.`
        : rta != null && rta < 0
          ? 'Penny is over-stuffed.'
          : 'Every dollar has a job. Penny is content.';
  const mood = reviewCount > 0
    ? 'squinting'
    : !glance.budget.exists
      ? 'hungry'
      : rta != null && rta < 0
        ? 'stuffed'
        : rta != null && rta > 0
          ? 'hungry'
          : 'fed';
  const barTone = rta != null && rta < 0 ? 'over' : allClear ? 'rainbow' : 'fill';
  const spentUp = glance.spent.deltaCents > 0;
  const spentDown = glance.spent.deltaCents < 0;
  const hasSpend = glance.spent.thisMonthCents > 0 || glance.spent.lastMonthSameDayCents > 0;
  const showDelta = glance.spent.hasLastMonthData;
  const latestYmd = glance.latestDataAt != null
    ? new Date(glance.latestDataAt).toLocaleDateString('en-SG', { timeZone: 'Asia/Singapore' })
    : null;
  const todayYmd = new Date(glance.asOf).toLocaleDateString('en-SG', { timeZone: 'Asia/Singapore' });
  const latestLagging = Boolean(latestYmd && latestYmd !== todayYmd);

  return (
    <div data-testid="home-shell">
      <div className="home-glance" data-testid="home-glance">
        <div className="hero" data-testid="home-hero">
          {glance.budget.exists && rta != null ? (
            <>
              <div className="kicker">Ready to assign</div>
              <div className={`big-number ${rta < 0 ? 'amount-over' : ''} ${allClear ? 'rainbow-digits' : ''}`}>
                {formatSgd(rta)}
              </div>
              <BracketBar ratio={funded} tone={barTone} />
            </>
          ) : (
            <button
              type="button"
              className="pill"
              data-testid="home-budget-pill"
              onClick={onBudget}
            >
              set up your budget
            </button>
          )}
          <Penny mood={mood} caption={caption} />
          <p className="penny-caption">{caption}</p>
        </div>

        {reviewCount > 0 ? (
          <button type="button" className="todo-link" data-testid="home-cta" onClick={onReview}>
            <span>{reviewCount} to check · about {Math.max(1, Math.round(reviewCount / 12))} min</span>
            <span>→</span>
          </button>
        ) : null}

        <section className="card home-section" data-testid="home-spent">
          <h2>This month so far</h2>
          {hasSpend ? (
            <>
              <div className="home-spend-total">{formatSgd(glance.spent.thisMonthCents)}</div>
              {showDelta ? (
                <p
                  className={`home-delta ${spentUp ? 'up' : ''} ${spentDown ? 'down' : ''}`}
                  data-testid="home-spent-delta"
                >
                  {glance.spent.deltaCents === 0
                    ? 'same as last month'
                    : spentUp
                      ? `up ${formatSgd(glance.spent.deltaCents)} vs last month`
                      : `down ${formatSgd(-glance.spent.deltaCents)} vs last month`}
                </p>
              ) : null}
              {latestLagging && glance.latestDataAt != null ? (
                <p className="home-muted" data-testid="home-latest-data">
                  latest data: {formatListDate(glance.latestDataAt)}
                </p>
              ) : null}
              {glance.topCategories.length === 0 ? (
                <p className="home-muted">No categorised spend yet.</p>
              ) : (
                <ul className="home-cat-list">
                  {glance.topCategories.map((cat) => (
                    <li key={cat.label} className="home-row">
                      <span className="home-row-main">
                        <PixelIcon name={categoryIconName(cat.label)} active />
                        <span>{cat.label}</span>
                      </span>
                      <span className="home-row-side">
                        <BracketBar ratio={cat.ratio} cells={8} tone="fill" />
                        <span className="amount">{formatSgd(cat.spentCents)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p className="home-muted" data-testid="home-spent-empty">No spending yet this month.</p>
          )}
        </section>

        <section className="card home-section" data-testid="home-accounts">
          <h2>Accounts</h2>
          {glance.accounts.length === 0 ? (
            <p className="home-muted" data-testid="home-accounts-empty">No accounts yet.</p>
          ) : (
            <>
              <div className="home-networth" data-testid="home-networth">
                <span className="kicker">Net worth</span>
                <div className="home-spend-total">
                  {glance.netWorth.knownAccountCount === 0
                    ? 'needs starting balance'
                    : formatSgd(glance.netWorth.cents)}
                </div>
                {glance.netWorth.missingAccountCount > 0 ? (
                  <p className="home-muted">
                    {glance.netWorth.missingAccountCount} account{glance.netWorth.missingAccountCount === 1 ? '' : 's'} need{glance.netWorth.missingAccountCount === 1 ? 's' : ''} a starting balance
                  </p>
                ) : null}
              </div>
              <ul className="home-account-list">
                {glance.accounts.map((account) => (
                  <li key={account.id} className="home-row" data-testid={`home-account-${account.id}`}>
                    <span className="home-row-main">
                      <span>{account.name}</span>
                      {account.asOf != null ? (
                        <span className="home-muted">as of {formatListDate(account.asOf)}</span>
                      ) : null}
                    </span>
                    <span className="home-row-side">
                      {account.needsStartingBalance || account.balanceCents == null ? (
                        <span className="home-muted">needs starting balance</span>
                      ) : (
                        <span className="amount">
                          {formatSgd(account.group === 'credit' ? -Math.abs(account.balanceCents) : account.balanceCents)}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section className="card home-section" data-testid="home-recent">
          <h2>Recent</h2>
          {glance.recent.length === 0 ? (
            <p className="home-muted" data-testid="home-recent-empty">No transactions yet.</p>
          ) : (
            <ul className="home-recent-list">
              {glance.recent.map((tx) => (
                <li key={tx.id} className="home-row">
                  <span className="home-row-main">
                    <PixelIcon name={categoryIconName(tx.categoryLabel)} active />
                    <span>{tx.merchant}</span>
                  </span>
                  <span className="amount">{formatSignedSgd(tx.amountCents)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
