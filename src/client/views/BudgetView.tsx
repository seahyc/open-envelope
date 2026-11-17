import { useState, useEffect, FormEvent } from 'react';
import { api, apiPost } from '../api';

interface Envelope {
  id: string;
  name: string;
  owner: string;
  monthly_target_cents: number | null;
  color: string | null;
}

interface Allocation {
  id: string;
  envelope_id: string;
  month: string;
  allocated_cents: number;
  envelope: Envelope;
}

interface BudgetData {
  readyToAssign: number;
  allocations: Allocation[];
}

export function BudgetView() {
  const currentMonth = new Date().toISOString().substring(0, 7);
  const [month, setMonth] = useState(currentMonth);
  const [budgetData, setBudgetData] = useState<BudgetData | null>(null);
  const [showEnvelopeForm, setShowEnvelopeForm] = useState(false);
  const [showAssignForm, setShowAssignForm] = useState(false);
  const [selectedEnvelopeId, setSelectedEnvelopeId] = useState<string>('');
  const [assignAmount, setAssignAmount] = useState('');
  const [newEnvelopeName, setNewEnvelopeName] = useState('');
  const [newEnvelopeOwner, setNewEnvelopeOwner] = useState<'shared' | 'alex' | 'sam'>('shared');
  const [newEnvelopeTarget, setNewEnvelopeTarget] = useState('');

  useEffect(() => {
    loadBudget();
  }, [month]);

  async function loadBudget() {
    const data = await api<BudgetData>(`/api/budget/${month}`);
    setBudgetData(data);
  }

  async function createEnvelope(e: FormEvent) {
    e.preventDefault();
    
    const target = newEnvelopeTarget ? Math.round(parseFloat(newEnvelopeTarget) * 100) : undefined;
    
    await apiPost('/api/envelopes', {
      name: newEnvelopeName,
      owner: newEnvelopeOwner,
      monthlyTargetCents: target,
    });

    setNewEnvelopeName('');
    setNewEnvelopeOwner('shared');
    setNewEnvelopeTarget('');
    setShowEnvelopeForm(false);
    loadBudget();
  }

  async function assignToEnvelope(e: FormEvent) {
    e.preventDefault();
    
    const amountCents = Math.round(parseFloat(assignAmount) * 100);
    
    await apiPost('/api/budget/allocate', {
      envelopeId: selectedEnvelopeId,
      month,
      amountCents,
    });

    setSelectedEnvelopeId('');
    setAssignAmount('');
    setShowAssignForm(false);
    loadBudget();
  }

  function formatAmount(cents: number): string {
    const dollars = Math.abs(cents) / 100;
    return `$${dollars.toFixed(2)}`;
  }

  if (!budgetData) {
    return <div className="card">Loading budget...</div>;
  }

  return (
    <div>
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
          <h2>Budget - {month}</h2>
          <input
            type="month"
            className="input"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            style={{ width: 'auto' }}
          />
        </div>

        <div style={{
          padding: '1.5rem',
          background: 'var(--color-bg)',
          borderRadius: '0.5rem',
          marginBottom: '1.5rem',
          border: '2px solid var(--color-primary)',
        }}>
          <div style={{ fontSize: '0.875rem', color: 'var(--color-text-dim)', marginBottom: '0.5rem' }}>
            Ready to Assign
          </div>
          <div style={{ fontSize: '2rem', fontWeight: '700', marginBottom: '1rem' }}>
            {formatAmount(budgetData.readyToAssign)}
          </div>
          {budgetData.readyToAssign > 0 && (
            <button 
              className="btn"
              onClick={() => setShowAssignForm(!showAssignForm)}
              style={{ fontSize: '0.875rem', padding: '0.5rem 1rem' }}
            >
              {showAssignForm ? 'Cancel' : 'Assign Money'}
            </button>
          )}
        </div>

        {showAssignForm && (
          <form onSubmit={assignToEnvelope} style={{
            marginBottom: '1.5rem',
            padding: '1rem',
            background: 'var(--color-bg)',
            borderRadius: '0.375rem',
            border: '1px solid var(--color-border)',
          }}>
            <h3 style={{ marginBottom: '1rem' }}>Assign to Envelope</h3>
            
            <div style={{ marginBottom: '1rem' }}>
              <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem' }}>
                Envelope
              </label>
              <select
                className="input"
                value={selectedEnvelopeId}
                onChange={(e) => setSelectedEnvelopeId(e.target.value)}
                required
              >
                <option value="">Select envelope...</option>
                {budgetData.allocations.map((allocation) => (
                  <option key={allocation.envelope_id} value={allocation.envelope_id}>
                    {allocation.envelope.name} ({allocation.envelope.owner})
                  </option>
                ))}
              </select>
            </div>

            <div style={{ marginBottom: '1rem' }}>
              <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem' }}>
                Amount
              </label>
              <input
                type="number"
                step="0.01"
                className="input"
                value={assignAmount}
                onChange={(e) => setAssignAmount(e.target.value)}
                placeholder="100.00"
                required
              />
            </div>

            <button type="submit" className="btn">Assign</button>
          </form>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h3>Envelopes</h3>
          <button className="btn btn-secondary" onClick={() => setShowEnvelopeForm(!showEnvelopeForm)}>
            {showEnvelopeForm ? 'Cancel' : 'New Envelope'}
          </button>
        </div>

        {showEnvelopeForm && (
          <form onSubmit={createEnvelope} style={{
            marginBottom: '1.5rem',
            padding: '1rem',
            background: 'var(--color-bg)',
            borderRadius: '0.375rem',
          }}>
            <div style={{ marginBottom: '1rem' }}>
              <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem' }}>
                Envelope Name
              </label>
              <input
                type="text"
                className="input"
                value={newEnvelopeName}
                onChange={(e) => setNewEnvelopeName(e.target.value)}
                placeholder="Groceries"
                required
              />
            </div>

            <div style={{ marginBottom: '1rem' }}>
              <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem' }}>
                Owner
              </label>
              <select
                className="input"
                value={newEnvelopeOwner}
                onChange={(e) => setNewEnvelopeOwner(e.target.value as 'shared' | 'alex' | 'sam')}
              >
                <option value="shared">Shared</option>
                <option value="alex">Alex</option>
                <option value="sam">Sam</option>
              </select>
            </div>

            <div style={{ marginBottom: '1rem' }}>
              <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem' }}>
                Monthly Target (optional)
              </label>
              <input
                type="number"
                step="0.01"
                className="input"
                value={newEnvelopeTarget}
                onChange={(e) => setNewEnvelopeTarget(e.target.value)}
                placeholder="500.00"
              />
            </div>

            <button type="submit" className="btn">Create Envelope</button>
          </form>
        )}

        {budgetData.allocations.length === 0 ? (
          <div className="empty-state">
            <p>No envelopes yet. Create your first envelope to start budgeting.</p>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: '1rem' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '1rem' }}>
              {budgetData.allocations.filter(a => a.envelope.owner === 'shared').map((allocation) => (
                <EnvelopeCard key={allocation.id} allocation={allocation} />
              ))}
            </div>
            
            {budgetData.allocations.some(a => a.envelope.owner === 'alex') && (
              <>
                <h3 style={{ marginTop: '1rem', color: 'var(--color-text-dim)', fontSize: '1rem' }}>Alex's Envelopes</h3>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '1rem' }}>
                  {budgetData.allocations.filter(a => a.envelope.owner === 'alex').map((allocation) => (
                    <EnvelopeCard key={allocation.id} allocation={allocation} />
                  ))}
                </div>
              </>
            )}
            
            {budgetData.allocations.some(a => a.envelope.owner === 'sam') && (
              <>
                <h3 style={{ marginTop: '1rem', color: 'var(--color-text-dim)', fontSize: '1rem' }}>Sam's Envelopes</h3>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '1rem' }}>
                  {budgetData.allocations.filter(a => a.envelope.owner === 'sam').map((allocation) => (
                    <EnvelopeCard key={allocation.id} allocation={allocation} />
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function EnvelopeCard({ allocation }: { 
  allocation: { 
    id: string; 
    allocated_cents: number; 
    envelope: { 
      name: string; 
      owner: string; 
      monthly_target_cents: number | null;
    };
  };
}) {
  function formatAmount(cents: number): string {
    const dollars = Math.abs(cents) / 100;
    return `$${dollars.toFixed(2)}`;
  }

  const target = allocation.envelope.monthly_target_cents;
  const percentage = target ? Math.min(100, (allocation.allocated_cents / target) * 100) : 0;

  return (
    <div style={{
      padding: '1rem',
      background: 'var(--color-bg)',
      borderRadius: '0.375rem',
      border: '1px solid var(--color-border)',
    }}>
      <div style={{ marginBottom: '0.75rem' }}>
        <div style={{ fontWeight: '600', marginBottom: '0.25rem' }}>
          {allocation.envelope.name}
        </div>
        <div style={{ fontSize: '0.75rem', color: 'var(--color-text-dim)', textTransform: 'capitalize' }}>
          {allocation.envelope.owner}
        </div>
      </div>
      
      <div style={{ fontSize: '1.5rem', fontWeight: '700', marginBottom: '0.5rem' }}>
        {formatAmount(allocation.allocated_cents)}
      </div>
      
      {target && (
        <>
          <div style={{ fontSize: '0.75rem', color: 'var(--color-text-dim)', marginBottom: '0.5rem' }}>
            of {formatAmount(target)} target
          </div>
          <div style={{
            height: '4px',
            background: 'var(--color-border)',
            borderRadius: '2px',
            overflow: 'hidden',
          }}>
            <div style={{
              height: '100%',
              width: `${percentage}%`,
              background: percentage >= 100 ? 'var(--color-success)' : 'var(--color-primary)',
              transition: 'width 0.3s',
            }} />
          </div>
        </>
      )}
    </div>
  );
}
