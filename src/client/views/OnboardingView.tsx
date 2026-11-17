import { useEffect, useState } from 'react';
import { api, apiPost, ApiClientError } from '../api';
import { Penny, type PennyMood } from '../components/Penny';

const STEPS = ['welcome', 'name', 'currency', 'start_date', 'invite', 'data_in', 'balances', 'envelopes', 'assign'] as const;
type Step = (typeof STEPS)[number];

const CURRENCIES = ['SGD', 'USD', 'EUR', 'GBP', 'MYR', 'IDR', 'AUD', 'JPY', 'HKD', 'CNY'];
const SUGGESTED_ENVELOPES = ['Groceries', 'Eating Out', 'Transport', 'Home', 'Utilities'];

interface Status {
  onboarded?: boolean;
  step?: string;
  payload?: Record<string, unknown>;
  householdName?: string;
  currency?: string;
}

function defaultStartDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

export function OnboardingView({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState<Step>('welcome');
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('SGD');
  const [startDate, setStartDate] = useState(defaultStartDate());
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [accountName, setAccountName] = useState('');
  const [accountGroup, setAccountGroup] = useState<'budget' | 'credit' | 'tracking'>('budget');
  const [balance, setBalance] = useState('');
  const [envelopes, setEnvelopes] = useState<string[]>([...SUGGESTED_ENVELOPES]);
  const [error, setError] = useState<string | null>(null);
  const [resume, setResume] = useState(false);
  const [unknownFormat, setUnknownFormat] = useState(false);
  const [inviteSent, setInviteSent] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api<Status>('/api/onboarding/status')
      .then((status) => {
        const payload = status.payload ?? {};
        if (typeof payload.name === 'string') setName(payload.name);
        if (typeof payload.currency === 'string') setCurrency(payload.currency);
        if (typeof payload.budgetStartDate === 'string') setStartDate(payload.budgetStartDate);
        if (typeof payload.inviteEmail === 'string') setInviteEmail(payload.inviteEmail);
        if (typeof payload.accountName === 'string') setAccountName(payload.accountName);
        if (Array.isArray(payload.envelopes)) setEnvelopes(payload.envelopes as string[]);
        if (payload.inviteSent) setInviteSent(true);
        if (typeof payload.inviteUrl === 'string') setInviteUrl(payload.inviteUrl);
        const saved = status.step;
        if (saved && saved !== 'welcome' && saved !== 'complete' && (STEPS as readonly string[]).includes(saved)) {
          setStep(saved as Step);
          setResume(true);
        }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  async function persist(next: Step, extra: Record<string, unknown> = {}) {
    setError(null);
    try {
      await apiPost('/api/onboarding/progress', {
        step: next,
        payload: {
          name,
          currency,
          budgetStartDate: startDate,
          inviteEmail,
          accountName,
          envelopes,
          ...extra,
        },
      });
      setStep(next);
      setResume(false);
    } catch (err) {
      if (err instanceof ApiClientError && err.kind === 'session') return;
      setError(`✕ ${err instanceof Error ? err.message : 'Nothing was saved.'}`);
    }
  }

  async function finish() {
    setError(null);
    try {
      const you = name.trim() || 'You';
      const parsed = balance.trim() === '' ? null : Number.parseFloat(balance);
      if (parsed !== null && Number.isNaN(parsed)) {
        setError('✕ not a number');
        return;
      }
      await apiPost('/api/onboarding/setup', {
        members: [{ name: you, email: `${you.toLowerCase().replace(/\s+/g, '.')}@example.test` }],
        accounts: accountName.trim()
          ? [{
              name: accountName.trim(),
              aliases: [],
              group: accountGroup,
              startingBalanceCents: parsed === null ? null : Math.round(parsed * 100),
              startDate: new Date(startDate).getTime(),
            }]
          : [],
      });
      onComplete();
    } catch (err) {
      if (err instanceof ApiClientError && err.kind === 'session') return;
      setError(`✕ ${err instanceof Error ? err.message : 'Onboarding failed'}`);
    }
  }

  async function sendInvite() {
    setError(null);
    try {
      const result = await apiPost<{ url?: string }>('/api/household/invite', { email: inviteEmail || undefined });
      const url = result.url ?? null;
      setInviteUrl(url);
      setInviteSent(true);
      await persist('invite', { inviteEmail, inviteSent: true, inviteUrl: url });
    } catch {
      setError("✕ We couldn't send. Copy the link instead.");
    }
  }

  async function startOver() {
    setName('');
    setCurrency('SGD');
    setStartDate(defaultStartDate());
    setInviteEmail('');
    setInviteUrl(null);
    setInviteSent(false);
    setAccountName('');
    setBalance('');
    setEnvelopes([...SUGGESTED_ENVELOPES]);
    await persist('welcome');
  }

  const idx = Math.max(0, STEPS.indexOf(step));
  const bar = `${'█'.repeat(idx)}${'░'.repeat(Math.max(0, STEPS.length - idx))}`;

  if (!loaded) {
    return <div className="oe-onboard skeleton" data-testid="onboard-shell">░░░░░░░░░░░░░░░░░░░░</div>;
  }

  const mood: PennyMood = step === 'assign' ? 'hungry' : step === 'welcome' ? 'fed' : 'squinting';

  return (
    <div className="oe-onboard" data-testid="onboard-shell">
      <div className="help" aria-hidden="true">[{bar}]</div>
      {resume ? (
        <div className="oe-stack" data-testid="onboard-resume">
          <p className="help">You stopped at {step.replace('_', ' ')}. Penny kept the envelope warm.</p>
          <button type="button" className="oe-btn-secondary" data-testid="onboard-start-over" onClick={() => void startOver()}>
            start over
          </button>
        </div>
      ) : null}
      <Penny mood={mood} caption={step === 'welcome' ? 'Hi.' : 'One household budget.'} />
      {error ? <div className="error-card" role="alert">{error}</div> : null}

      {step === 'welcome' && (
        <div className="oe-stack">
          <h1>HI.</h1>
          <p>One household budget. You and your person. Penny watches the envelopes.</p>
          <button type="button" className="oe-btn" data-testid="onboard-next" onClick={() => void persist('name')}>
            let's go
          </button>
          <a className="help" href="/signin">I have an invite</a>
        </div>
      )}

      {step === 'name' && (
        <div className="oe-stack">
          <h2>Household name</h2>
          <input className="oe-input" name="householdName" placeholder="What should we call this household?" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
          <button
            type="button"
            className="oe-btn"
            data-testid="onboard-next"
            onClick={() => {
              if (name.trim().length > 40) {
                setError('✕ too long');
                return;
              }
              void persist('currency', { name: name.trim() || 'Household' });
            }}
          >
            continue
          </button>
          <button type="button" className="oe-btn-secondary" onClick={() => void persist('currency', { name: 'Household' })}>
            skip — call it Household
          </button>
        </div>
      )}

      {step === 'currency' && (
        <div className="oe-stack">
          <h2>Currency</h2>
          <p className="help">SGD is the default. You can change this later in Settings.</p>
          <select className="oe-input" name="currency" value={currency} onChange={(e) => setCurrency(e.target.value)} aria-label="Currency">
            {CURRENCIES.map((code) => <option key={code} value={code}>{code}</option>)}
          </select>
          <button type="button" className="oe-btn" data-testid="onboard-next" onClick={() => void persist('start_date', { currency })}>
            continue
          </button>
        </div>
      )}

      {step === 'start_date' && (
        <div className="oe-stack">
          <h2>Budget start date</h2>
          <p className="help">We'll count Ready to Assign from this day. Older statements won't inflate this month's RTA.</p>
          <input className="oe-input" type="date" name="budgetStartDate" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          <button
            type="button"
            className="oe-btn"
            data-testid="onboard-next"
            disabled={!startDate || startDate > new Date().toISOString().slice(0, 10)}
            onClick={() => {
              if (startDate > new Date().toISOString().slice(0, 10)) {
                setError('✕ that\'s tomorrow');
                return;
              }
              void persist('invite', { budgetStartDate: startDate });
            }}
          >
            continue
          </button>
        </div>
      )}

      {step === 'invite' && (
        <div className="oe-stack">
          <h2>Invite partner</h2>
          {inviteSent ? (
            <>
              <p data-testid="onboard-invite-sent">Link copied / email queued. They have 48 hours.</p>
              {inviteUrl ? <p className="help" data-testid="onboard-invite-url">{inviteUrl}</p> : null}
              <button type="button" className="oe-btn" data-testid="onboard-next" onClick={() => void persist('data_in')}>
                continue
              </button>
              <button type="button" className="oe-btn-secondary" onClick={() => { setInviteSent(false); setInviteUrl(null); }}>
                invite someone else
              </button>
            </>
          ) : (
            <>
              <input className="oe-input" type="email" name="inviteEmail" placeholder="partner@example.com" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} />
              {inviteUrl ? <p className="help" data-testid="onboard-invite-url">{inviteUrl}</p> : null}
              <button type="button" className="oe-btn" onClick={() => void sendInvite()} disabled={Boolean(inviteEmail) && !inviteEmail.includes('@')}>
                send invite
              </button>
              <button type="button" className="oe-btn-secondary" data-testid="onboard-skip-invite" onClick={() => void persist('data_in', { inviteSkipped: true })}>
                skip for now
              </button>
            </>
          )}
        </div>
      )}

      {step === 'data_in' && (
        <div className="oe-stack">
          <h2>Get data in</h2>
          <p className="help">We never invent a balance. If you don't know it, leave it blank.</p>
          {unknownFormat ? (
            <div className="error-card" data-testid="onboard-unknown-format">Don't know this bank layout yet.</div>
          ) : null}
          <label className="oe-btn-secondary">
            upload statements
            <input
              type="file"
              name="statement"
              accept=".pdf,.csv,.ofx,.qfx"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                if (!/\.(csv|ofx|qfx|pdf)$/i.test(file.name) && file.type === 'application/octet-stream') {
                  setUnknownFormat(true);
                  return;
                }
                setUnknownFormat(false);
                void persist('balances', { uploaded: file.name });
              }}
            />
          </label>
          <div className="oe-stack">
            <input className="oe-input" name="accountName" placeholder="Account name" value={accountName} onChange={(e) => setAccountName(e.target.value)} />
            <select className="oe-input" name="accountGroup" value={accountGroup} onChange={(e) => setAccountGroup(e.target.value as typeof accountGroup)} aria-label="Account group">
              <option value="budget">budget (cash)</option>
              <option value="credit">credit card</option>
              <option value="tracking">tracking (CPF / SRS)</option>
            </select>
            {accountGroup === 'tracking' ? (
              <p className="help">CPF, SRS, and other off-budget pots. They never touch Ready to Assign.</p>
            ) : null}
          </div>
          <button
            type="button"
            className="oe-btn"
            data-testid="onboard-next"
            disabled={!accountName.trim()}
            onClick={() => void persist('balances', { accountName, accountGroup })}
          >
            add account by hand
          </button>
          <button type="button" className="oe-btn-secondary" data-testid="onboard-skip-data" onClick={() => void persist('envelopes', { dataSkipped: true })}>
            skip — look around first
          </button>
        </div>
      )}

      {step === 'balances' && (
        <div className="oe-stack">
          <h2>Starting balance</h2>
          <p className="help">Leave blank if you don't know. Typed 0 is zero, not a guess.</p>
          <input className="oe-input" inputMode="decimal" name="startingBalance" placeholder="leave blank if unknown" value={balance} onChange={(e) => setBalance(e.target.value)} />
          <button
            type="button"
            className="oe-btn"
            data-testid="onboard-next"
            onClick={() => {
              if (balance.trim() !== '' && Number.isNaN(Number.parseFloat(balance))) {
                setError('✕ not a number');
                return;
              }
              void persist('envelopes', { balance });
            }}
          >
            continue
          </button>
          <button type="button" className="oe-btn-secondary" onClick={() => void persist('envelopes', { balance: '' })}>
            skip
          </button>
        </div>
      )}

      {step === 'envelopes' && (
        <div className="oe-stack">
          <h2>Envelopes</h2>
          <p className="help">One household budget. A private envelope for each of you can wait.</p>
          {SUGGESTED_ENVELOPES.map((label) => (
            <label key={label} className="help">
              <input
                type="checkbox"
                checked={envelopes.includes(label)}
                onChange={(e) => {
                  setEnvelopes((current) => e.target.checked ? [...current, label] : current.filter((item) => item !== label));
                }}
              />{' '}
              {label}
            </label>
          ))}
          <button type="button" className="oe-btn" data-testid="onboard-next" onClick={() => void persist('assign', { envelopes })}>
            create these
          </button>
          <button type="button" className="oe-btn-secondary" onClick={() => void persist('assign', { envelopes: [] })}>
            skip — I'll add later
          </button>
        </div>
      )}

      {step === 'assign' && (
        <div className="oe-stack" data-testid="onboard-assign">
          <h2>Ready to Assign</h2>
          <p>When pay lands, it waits here as Ready to Assign. Give every dollar a job from Budget.</p>
          <Penny mood="hungry" caption="Give the dollars a job." />
          <button type="button" className="oe-btn" data-testid="onboard-finish" onClick={() => void finish()}>
            go to Home
          </button>
          <button type="button" className="oe-btn-secondary" onClick={() => void finish()}>
            I'll do this later
          </button>
        </div>
      )}
    </div>
  );
}
