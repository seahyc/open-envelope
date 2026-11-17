import { useEffect, useState } from 'react';
import { api, apiPost, ApiClientError } from '../api';
import { Penny } from '../components/Penny';

interface Household {
  name?: string;
  currency?: string;
}

interface Intelligence {
  appMode?: string;
  provider?: string;
  dailyCap?: number;
  fallback?: string;
  copy?: string;
}

export function HouseholdView() {
  const [household, setHousehold] = useState<Household | null>(null);
  const [intelligence, setIntelligence] = useState<Intelligence | null>(null);
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [exported, setExported] = useState(false);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    api<Household>('/api/household')
      .then(setHousehold)
      .catch(() => undefined);
    api<Intelligence>('/api/household/intelligence')
      .then(setIntelligence)
      .catch(() => undefined);
  }, []);

  async function exportData() {
    setError(null);
    try {
      const data = await api<unknown>('/api/household/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'openenvelope-export.json';
      link.click();
      URL.revokeObjectURL(url);
      setExported(true);
    } catch (err) {
      if (err instanceof ApiClientError && err.kind === 'session') return;
      setError(`✕ ${err instanceof Error ? err.message : 'Export failed'}`);
    }
  }

  async function remove() {
    setError(null);
    try {
      await apiPost('/api/household/delete', { name: confirm });
      setGone(true);
    } catch (err) {
      if (err instanceof ApiClientError && err.kind === 'session') return;
      setError(`✕ ${err instanceof Error ? err.message : 'Delete failed'}`);
    }
  }

  if (gone) {
    return (
      <div className="oe-onboard" data-testid="household-gone">
        <Penny mood="asleep" caption="Household gone." />
        <h1>Household gone</h1>
        <a className="oe-btn" href="/">start again</a>
      </div>
    );
  }

  return (
    <div className="oe-stack" data-testid="household-shell">
      <h1>Household</h1>
      <p className="help">{household?.name ?? 'Household'} · {household?.currency ?? 'SGD'}</p>
      {error ? <div className="error-card" role="alert">{error}</div> : null}

      <section className="card">
        <h2>Intelligence</h2>
        <p data-testid="household-llm">{intelligence?.copy ?? 'Categoriser falls back to merchant memory and rules when no LLM is configured.'}</p>
        <p className="help">
          Mode {intelligence?.appMode ?? 'selfhost'} · provider {intelligence?.provider ?? 'none'}
          {intelligence?.dailyCap ? ` · ${intelligence.dailyCap}/day` : ''}
        </p>
        <p className="help">Fallback: {intelligence?.fallback ?? 'merchant memory and rules'}.</p>
      </section>

      <section className="card">
        <h2>Export</h2>
        <p className="help">JSON of this household only. Documents stay as hashes.</p>
        <button type="button" className="oe-btn" data-testid="household-export" onClick={() => void exportData()}>
          export JSON
        </button>
        {exported ? <p data-testid="household-exported">Download started. This is your data.</p> : null}
      </section>

      <section className="card">
        <h2>Delete household</h2>
        <p className="help">This removes the budget for both of you. Type the household name.</p>
        <input
          className="oe-input"
          name="deleteName"
          placeholder={household?.name ?? 'Household'}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        <button
          type="button"
          className="oe-btn-secondary"
          data-testid="household-delete"
          disabled={!confirm.trim()}
          onClick={() => void remove()}
        >
          delete household
        </button>
      </section>
    </div>
  );
}
