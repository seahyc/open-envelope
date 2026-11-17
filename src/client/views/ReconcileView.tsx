import { useState, useEffect } from 'react';
import { api } from '../api';

interface Account {
  id: string;
  name: string;
}

interface StatementPeriod {
  id: string;
  start_date: number;
  end_date: number;
  opening_balance_cents: number;
  closing_balance_cents: number;
  reconciled_at: number | null;
  discrepancy_cents: number | null;
}

export function ReconcileView() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [periods, setPeriods] = useState<StatementPeriod[]>([]);
  const [showNewPeriodForm, setShowNewPeriodForm] = useState(false);

  useEffect(() => {
    loadAccounts();
  }, []);

  useEffect(() => {
    if (selectedAccountId) {
      loadPeriods(selectedAccountId);
    }
  }, [selectedAccountId]);

  async function loadAccounts() {
    const data = await api<Account[]>('/api/accounts');
    setAccounts(data);
  }

  async function loadPeriods(accountId: string) {
    const data = await api<StatementPeriod[]>(`/api/reconcile/${accountId}/periods`);
    setPeriods(data);
  }

  function formatAmount(cents: number): string {
    const dollars = Math.abs(cents) / 100;
    return `$${dollars.toFixed(2)}`;
  }

  function formatDate(timestamp: number): string {
    return new Date(timestamp).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }

  return (
    <div>
      <div className="card">
        <h2>Reconcile</h2>
        <p style={{ color: 'var(--color-text-dim)', marginBottom: '1.5rem' }}>
          Match your statement balance to transactions and mark them as reconciled.
        </p>

        <div style={{ marginBottom: '1.5rem' }}>
          <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem' }}>
            Select Account
          </label>
          <select
            className="input"
            value={selectedAccountId}
            onChange={(e) => setSelectedAccountId(e.target.value)}
          >
            <option value="">Choose an account...</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </div>

        {selectedAccountId && (
          <>
            <div style={{ marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3>Statement Periods</h3>
              <button 
                className="btn btn-secondary"
                onClick={() => setShowNewPeriodForm(!showNewPeriodForm)}
              >
                {showNewPeriodForm ? 'Cancel' : 'New Period'}
              </button>
            </div>

            {periods.length === 0 ? (
              <div className="empty-state">
                <p>No statement periods yet. Add your first statement period to start reconciling.</p>
              </div>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Period</th>
                    <th>Opening</th>
                    <th>Closing</th>
                    <th>Status</th>
                    <th>Discrepancy</th>
                  </tr>
                </thead>
                <tbody>
                  {periods.map((period) => (
                    <tr key={period.id}>
                      <td>
                        {formatDate(period.start_date)} - {formatDate(period.end_date)}
                      </td>
                      <td>{formatAmount(period.opening_balance_cents)}</td>
                      <td>{formatAmount(period.closing_balance_cents)}</td>
                      <td>
                        {period.reconciled_at ? (
                          <span className="badge badge-reconciled">Reconciled</span>
                        ) : (
                          <span className="badge badge-pending">Pending</span>
                        )}
                      </td>
                      <td>
                        {period.discrepancy_cents !== null && period.discrepancy_cents !== 0 ? (
                          <span style={{ color: 'var(--color-danger)', fontWeight: '600' }}>
                            {formatAmount(period.discrepancy_cents)}
                          </span>
                        ) : period.reconciled_at ? (
                          <span style={{ color: 'var(--color-success)' }}>Match</span>
                        ) : (
                          '-'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </div>
  );
}
