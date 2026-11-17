import { useState, useEffect, Fragment } from 'react';
import { api, apiPost } from '../api';

interface ContextSnippet {
  id: string;
  kind: string;
  snippet: string;
  proposedSplit: Array<{ name: string }> | null;
  memberName: string | null;
}

interface Transaction {
  id: string;
  account_id: string;
  amount_cents: number;
  currency: string;
  timestamp: number;
  merchant_text: string;
  state: string;
  category: string | null;
  envelope_id: string | null;
  notes: string | null;
  contextSnippets?: ContextSnippet[];
}

export function TransactionsView() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [reviewQueue, setReviewQueue] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    setLoading(true);
    
    const [txData, reviewData] = await Promise.all([
      api<Transaction[]>('/api/transactions'),
      api<{ items?: Transaction[] } | Transaction[]>('/api/review-queue'),
    ]);

    setTransactions(txData);
    setReviewQueue(Array.isArray(reviewData) ? reviewData : reviewData.items ?? []);
    setLoading(false);
  }

  async function handleResolve(txId: string) {
    await apiPost(`/api/transactions/${txId}/resolve`, {});
    loadData();
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

  if (loading) {
    return <div className="card">Loading...</div>;
  }

  return (
    <div>
      {reviewQueue.length > 0 && (
        <div className="card" style={{ borderColor: 'var(--color-warning)' }}>
          <h2>Review Queue ({reviewQueue.length})</h2>
          <p style={{ color: 'var(--color-text-dim)', marginBottom: '1rem' }}>
            These transactions need your attention.
          </p>
          
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Merchant</th>
                <th>Amount</th>
                <th>State</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {reviewQueue.map((tx) => (
                <tr key={tx.id}>
                  <td>{formatDate(tx.timestamp)}</td>
                  <td>{tx.merchant_text}</td>
                  <td className={`amount ${tx.amount_cents < 0 ? 'amount-negative' : 'amount-positive'}`}>
                    {tx.amount_cents < 0 ? '-' : '+'}
                    {formatAmount(tx.amount_cents)}
                  </td>
                  <td>
                    <span className={`badge badge-${tx.state}`}>
                      {tx.state}
                    </span>
                  </td>
                  <td>
                    <div style={{ color: 'var(--color-warning)', fontSize: '0.875rem', marginBottom: '0.5rem' }}>
                      {tx.notes}
                    </div>
                    <button 
                      className="btn btn-secondary"
                      style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}
                      onClick={() => handleResolve(tx.id)}
                    >
                      Resolve
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h2>Recent Transactions</h2>
        
        {transactions.length === 0 ? (
          <div className="empty-state">
            <p>No transactions yet. Import statements to get started.</p>
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Merchant</th>
                <th>Amount</th>
                <th>State</th>
                <th>Category</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((tx) => (
                <Fragment key={tx.id}>
                  <tr onClick={() => setOpenId(openId === tx.id ? null : tx.id)} style={{ cursor: 'pointer' }}>
                    <td>{formatDate(tx.timestamp)}</td>
                    <td>{tx.merchant_text}</td>
                    <td className={`amount ${tx.amount_cents < 0 ? 'amount-negative' : 'amount-positive'}`}>
                      {tx.amount_cents < 0 ? '-' : '+'}
                      {formatAmount(tx.amount_cents)}
                    </td>
                    <td>
                      <span className={`badge badge-${tx.state}`}>
                        {tx.state}
                      </span>
                    </td>
                    <td style={{ color: 'var(--color-text-dim)', fontSize: '0.875rem' }}>
                      {tx.category || 'Uncategorized'}
                    </td>
                  </tr>
                  {openId === tx.id && (tx.contextSnippets ?? []).length > 0 ? (
                    <tr key={`${tx.id}-ctx`}>
                      <td colSpan={5}>
                        <div className="review-context" data-testid="ledger-context">
                          {(tx.contextSnippets ?? []).map((snippet) => (
                            <p key={snippet.id}>{snippet.snippet}</p>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
