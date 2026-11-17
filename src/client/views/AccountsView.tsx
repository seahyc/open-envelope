import { useState, useEffect } from 'react';
import { api, apiPost } from '../api';

interface Account {
  id: string;
  name: string;
  aliases: string;
  account_group: string;
  created_at: number;
}

type ExtraId = 'import' | 'reconcile' | 'pipeline' | 'connections' | 'household';

export function AccountsView({
  extras = [],
  onOpenTool,
}: {
  extras?: Array<{ id: ExtraId; label: string }>;
  onOpenTool?: (id: ExtraId) => void;
}) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [aliases, setAliases] = useState('');
  const [group, setGroup] = useState<'budget' | 'credit' | 'tracking'>('budget');

  useEffect(() => {
    loadAccounts();
  }, []);

  async function loadAccounts() {
    const data = await api<Account[]>('/api/accounts');
    setAccounts(data);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    
    await apiPost('/api/accounts', {
      name,
      aliases: aliases.split(',').map(a => a.trim()).filter(Boolean),
      group,
    });

    setName('');
    setAliases('');
    setGroup('budget');
    setShowForm(false);
    loadAccounts();
  }

  return (
    <div data-testid="accounts-shell">
      {extras.length > 0 && onOpenTool ? (
        <div className="more-tools" data-testid="accounts-more">
          <h2>More</h2>
          <div className="chip-row">
            {extras.map((tool) => (
              <button
                key={tool.id}
                type="button"
                className="btn btn-secondary"
                onClick={() => onOpenTool(tool.id)}
              >
                {tool.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h2>Accounts</h2>
          <button className="btn" onClick={() => setShowForm(!showForm)}>
            {showForm ? 'Cancel' : 'Add Account'}
          </button>
        </div>

        {showForm && (
          <form onSubmit={handleSubmit} style={{ marginBottom: '1.5rem' }}>
            <div style={{ marginBottom: '1rem' }}>
              <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem' }}>
                Account Name
              </label>
              <input
                type="text"
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Chase Checking"
                required
              />
            </div>

            <div style={{ marginBottom: '1rem' }}>
              <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem' }}>
                Aliases (comma-separated, e.g., last 4 digits)
              </label>
              <input
                type="text"
                className="input"
                value={aliases}
                onChange={(e) => setAliases(e.target.value)}
                placeholder="1234, checking"
              />
            </div>

            <div style={{ marginBottom: '1rem' }}>
              <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem' }}>
                Account Group
              </label>
              <select
                className="input"
                value={group}
                onChange={(e) => setGroup(e.target.value as 'budget' | 'credit' | 'tracking')}
              >
                <option value="budget">Budget (Checking/Debit)</option>
                <option value="credit">Credit</option>
                <option value="tracking">Tracking (Investments, etc.)</option>
              </select>
            </div>

            <button type="submit" className="btn">Create Account</button>
          </form>
        )}

        {accounts.length === 0 ? (
          <div className="empty-state">
            <p>No accounts yet. Create your first account to get started.</p>
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Aliases</th>
                <th>Group</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.id}>
                  <td>{account.name}</td>
                  <td>{JSON.parse(account.aliases).join(', ')}</td>
                  <td style={{ textTransform: 'capitalize' }}>{account.account_group}</td>
                  <td>{new Date(account.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
