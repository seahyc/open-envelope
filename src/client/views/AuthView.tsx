import { useEffect, useState } from 'react';
import { api, apiPost, ApiClientError } from '../api';
import { Penny } from '../components/Penny';

interface AuthStatus {
  mode?: string;
  google?: boolean;
  authenticated?: boolean;
}

export function AuthView({
  inviteToken,
  onSignedIn,
}: {
  inviteToken?: string;
  onSignedIn?: () => void;
}) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [google, setGoogle] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<AuthStatus>('/api/auth/status')
      .then((status) => setGoogle(Boolean(status.google)))
      .catch(() => undefined);
  }, []);

  async function sendLink() {
    setError(null);
    setBusy(true);
    try {
      const result = await apiPost<{ ok?: boolean; captureUrl?: string }>('/api/auth/magic-link', { email });
      if (result.captureUrl) {
        window.location.assign(result.captureUrl);
        return;
      }
      setSent(true);
    } catch (err) {
      if (err instanceof ApiClientError && err.kind === 'session') {
        setError('✕ that link expired');
      } else {
        setError(`✕ ${err instanceof Error ? err.message : 'Could not send link'}`);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="oe-onboard" data-testid="auth-shell">
      <Penny mood="fed" caption="A budget for two." />
      <h1>OpenEnvelope</h1>
      <p className="help">Sign in. Google or a link we email you.</p>
      {inviteToken ? <p className="help">You have an invite. Sign in to join.</p> : null}
      {error ? <div className="error-card" role="alert">{error}</div> : null}
      {sent ? (
        <div className="oe-stack" data-testid="auth-magic-sent">
          <p>Check your email. The link lasts 15 minutes.</p>
          <button type="button" className="oe-btn-secondary" onClick={() => setSent(false)}>
            use a different email
          </button>
        </div>
      ) : (
        <div className="oe-stack">
          <input
            className="oe-input"
            type="email"
            name="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-label="Email"
          />
          <button
            type="button"
            className="oe-btn"
            disabled={!email.includes('@') || busy}
            onClick={() => void sendLink()}
            data-testid="auth-magic-submit"
          >
            email me a link
          </button>
          {google ? (
            <a className="oe-btn-secondary" href="/api/auth/google/start" data-testid="auth-google">
              continue with Google
            </a>
          ) : null}
          <a className="help" href={inviteToken ? `/join/${inviteToken}` : '/join/preview'}>
            I have an invite
          </a>
        </div>
      )}
      {onSignedIn ? (
        <button type="button" className="help" onClick={onSignedIn}>
          skip (dev)
        </button>
      ) : null}
    </div>
  );
}
