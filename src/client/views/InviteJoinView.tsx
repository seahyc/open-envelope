import { useEffect, useState } from 'react';
import { api, apiPost, ApiClientError } from '../api';
import { Penny } from '../components/Penny';

export function InviteJoinView({ token }: { token: string }) {
  const [name, setName] = useState('');
  const [consent, setConsent] = useState(false);
  const [household, setHousehold] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [needSignIn, setNeedSignIn] = useState(false);
  const [alreadyIn, setAlreadyIn] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await api<{ householdName?: string }>(`/api/join/${token}`);
        if (cancelled) return;
        setHousehold(data.householdName ?? 'this household');
        const auth = await api<{ mode?: string; authenticated?: boolean }>(`/api/auth/status`);
        if (cancelled) return;
        if (auth.mode === 'session' && !auth.authenticated) {
          setNeedSignIn(true);
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiClientError && err.kind === 'session') return;
        setInvalid(true);
        setError("✕ This invite doesn't work.");
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function join() {
    setError(null);
    try {
      await apiPost(`/api/join/${token}/accept`, { name, consent });
      window.location.assign('/');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Join failed';
      if (/already in/i.test(message)) {
        setAlreadyIn(true);
        setError("✕ You're already in another household.");
        return;
      }
      setError(`✕ ${message}`);
    }
  }

  async function decline() {
    setError(null);
    try {
      await apiPost(`/api/join/${token}/decline`, {});
      setInvalid(true);
      setError('You declined.');
    } catch (err) {
      setError(`✕ ${err instanceof Error ? err.message : 'Could not decline'}`);
    }
  }

  return (
    <div className="oe-onboard" data-testid="invite-shell">
      <Penny mood={invalid ? 'asleep' : 'fed'} caption={invalid ? 'That invite aged out.' : 'Join the household.'} />
      <h1>JOIN</h1>
      {error ? <div className="error-card" role="alert">{error}</div> : null}
      {invalid ? (
        <div className="oe-stack">
          <a className="oe-btn" href="/signin">ask for a new link</a>
          <a className="help" href="/">create my own household</a>
        </div>
      ) : alreadyIn ? (
        <div className="oe-stack">
          <p>Leave your current household before joining another.</p>
          <a className="oe-btn" href="/household">go to household</a>
        </div>
      ) : needSignIn ? (
        <div className="oe-stack" data-testid="invite-signin">
          <p>Join {household ?? '…'} as yourself.</p>
          <a className="oe-btn" href={`/signin?next=/join/${token}`}>sign in to join</a>
          <a className="help" href="/">this isn't for me</a>
        </div>
      ) : (
        <div className="oe-stack">
          <p>Join {household ?? '…'} as yourself.</p>
          <p className="help">Shared: budget, ledger, envelopes. Private: your receipts, calendar, location — off until you connect.</p>
          <input className="oe-input" name="partnerName" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} />
          <label className="help">
            <input type="checkbox" name="consent" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            {' '}I understand my partner can see shared transactions, and I choose which of my Connections to turn on.
          </label>
          <button type="button" className="oe-btn" data-testid="invite-join" disabled={!consent || !name.trim()} onClick={() => void join()}>
            join
          </button>
          <button type="button" className="oe-btn-secondary" data-testid="invite-decline" onClick={() => void decline()}>
            decline
          </button>
        </div>
      )}
    </div>
  );
}
