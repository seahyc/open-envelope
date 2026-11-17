import { useCallback, useEffect, useState } from 'react';
import { api, ApiClientError, setApiHandlers } from './api';
import { pathFromRoute, routeFromPath, type Route } from './routes';
import { HomeView } from './views/HomeView';
import { ReviewView } from './views/ReviewView';
import { BudgetView } from './views/BudgetView';
import { TransactionsView } from './views/TransactionsView';
import { AccountsView } from './views/AccountsView';
import { ImportView } from './views/ImportView';
import { ReconcileView } from './views/ReconcileView';
import { PipelineView } from './views/PipelineView';
import { ConnectionsView } from './views/ConnectionsView';
import { OnboardingView } from './views/OnboardingView';
import { AuthView } from './views/AuthView';
import { InviteJoinView } from './views/InviteJoinView';
import { HouseholdView } from './views/HouseholdView';
import { Penny } from './components/Penny';
import { PixelIcon } from './components/PixelIcon';

const TABS: Array<{ id: Route; label: string; short: string; icon: string }> = [
  { id: 'home', label: 'Home', short: 'Home', icon: 'home' },
  { id: 'review', label: 'Review', short: 'Review', icon: 'review' },
  { id: 'budget', label: 'Budget', short: 'Budget', icon: 'budget' },
  { id: 'ledger', label: 'Transactions', short: 'Ledger', icon: 'ledger' },
  { id: 'accounts', label: 'Accounts', short: 'Accounts', icon: 'accounts' },
];

const EXTRA: Array<{ id: 'import' | 'reconcile' | 'pipeline' | 'connections' | 'household'; label: string }> = [
  { id: 'import', label: 'Import' },
  { id: 'reconcile', label: 'Reconcile' },
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'connections', label: 'Connections' },
  { id: 'household', label: 'Household' },
];

const WIDE = new Set<Route>(['ledger', 'accounts', 'import', 'reconcile', 'pipeline']);

function tabIsActive(id: Route, route: Route): boolean {
  if (id === route) return true;
  return id === 'accounts' && (route === 'import' || route === 'reconcile' || route === 'pipeline' || route === 'connections' || route === 'household');
}

export function App() {
  const [route, setRoute] = useState<Route>(() => routeFromPath(window.location.pathname));
  const [onboarded, setOnboarded] = useState<boolean | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [reviewCount, setReviewCount] = useState(0);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [offline, setOffline] = useState(!navigator.onLine);
  const [slow, setSlow] = useState(false);

  const go = useCallback((next: Route) => {
    const path = pathFromRoute(next);
    if (window.location.pathname !== path) {
      window.history.pushState({}, '', path);
    }
    setRoute(next);
  }, []);

  useEffect(() => {
    setApiHandlers({
      onSession: () => setSessionExpired(true),
      onOffline: (value) => setOffline(value),
    });
    const onPop = () => setRoute(routeFromPath(window.location.pathname));
    const onOffline = () => setOffline(true);
    const onOnline = () => setOffline(false);
    window.addEventListener('popstate', onPop);
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), 300);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function boot() {
      try {
        const auth = await api<{ mode?: string; authenticated?: boolean }>('/api/auth/status');
        if (cancelled) return;
        if (auth.mode === 'session' && !auth.authenticated) {
          setSignedOut(true);
          setOnboarded(false);
          return;
        }
        const status = await api<{ onboarded?: boolean }>('/api/onboarding/status');
        if (cancelled) return;
        setOnboarded(Boolean(status.onboarded));
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiClientError && err.kind === 'session') {
          setSignedOut(true);
          setOnboarded(false);
          return;
        }
        setOnboarded(true);
      }
    }
    void boot();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!onboarded) return;
    api<{ count: number }>('/api/review')
      .then((data) => setReviewCount(data.count))
      .catch(() => undefined);
  }, [onboarded, route]);

  if (onboarded === null) {
    return slow ? (
      <div className="skeleton" style={{ padding: 48 }} role="status">░░░░░░░░░░░░░░░░░░░░</div>
    ) : null;
  }

  const path = window.location.pathname;
  const inviteMatch = path.match(/^\/join\/([^/]+)/);
  if (inviteMatch?.[1] && inviteMatch[1] !== 'preview') {
    return <InviteJoinView token={inviteMatch[1]} />;
  }
  if (signedOut || path === '/signin') {
    return <AuthView inviteToken={inviteMatch?.[1]} />;
  }

  if (!onboarded && route !== 'pipeline') {
    return <OnboardingView onComplete={() => setOnboarded(true)} />;
  }

  function renderTab(tab: (typeof TABS)[number], extraClass = '') {
    const active = tabIsActive(tab.id, route);
    return (
      <button
        key={tab.id}
        type="button"
        className={`${extraClass} ${active ? 'active' : ''}`.trim()}
        onClick={() => go(tab.id)}
        aria-label={tab.label}
        aria-current={active ? 'page' : undefined}
      >
        <PixelIcon name={tab.icon} active={active} />
        <span className="tab-label">{tab.short}</span>
        {tab.id === 'review' && reviewCount > 0 ? <span className="badge-count">{reviewCount}</span> : null}
      </button>
    );
  }

  return (
    <div className="shell" data-testid="app-shell">
      {offline ? <div className="strip">offline · showing cached data</div> : null}
      <nav className="rail" aria-label="Primary">
        {TABS.map((tab) => renderTab(tab))}
      </nav>

      <main className={`shell-main ${WIDE.has(route) ? 'wide' : ''}`}>
        {route === 'home' && <HomeView onReview={() => go('review')} onBudget={() => go('budget')} />}
        {route === 'review' && <ReviewView onBudget={() => go('budget')} />}
        {route === 'budget' && <BudgetView />}
        {route === 'ledger' && <TransactionsView />}
        {route === 'accounts' && (
          <AccountsView extras={EXTRA} onOpenTool={(id) => go(id)} />
        )}
        {route === 'import' && <ImportView />}
        {route === 'reconcile' && <ReconcileView />}
        {route === 'pipeline' && <PipelineView />}
        {route === 'connections' && <ConnectionsView />}
        {route === 'household' && <HouseholdView />}
      </main>

      <nav className="tabbar" aria-label="Mobile" data-testid="tabbar">
        {TABS.map((tab) => renderTab(tab))}
      </nav>

      {sessionExpired ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-labelledby="session-title">
            <Penny mood="asleep" caption="Penny dozed off" />
            <h2 id="session-title">Your session napped.</h2>
            <p>Sign in again — your edit is saved.</p>
            <button type="button" className="btn" onClick={() => { window.location.assign(window.location.href); }}>
              sign in again
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
