import { useState } from 'react';
import { api } from '../api';

interface ImportResult {
  documentHash: string;
  observationsCreated: number;
  observationsDuplicate: number;
  errors: string[];
}

export function ImportView() {
  const [file, setFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  async function handleImport() {
    if (!file) return;

    setImporting(true);
    setResult(null);

    const formData = new FormData();
    formData.append('file', file);

    try {
      const data = await api<ImportResult>('/api/import', {
        method: 'POST',
        body: formData,
      });
      setResult(data);
    } catch (error) {
      console.error('Import failed:', error);
    } finally {
      setImporting(false);
    }
  }

  return (
    <div>
      <div className="card">
        <h2>Import Transactions</h2>
        <p style={{ color: 'var(--color-text-dim)', marginBottom: '1.5rem' }}>
          Upload bank statements (CSV, OFX/QFX, PDF) or email alerts to import transactions.
        </p>

        <div style={{ marginBottom: '1.5rem' }}>
          <input
            type="file"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            accept=".csv,.ofx,.qfx,.pdf,.eml,.txt"
            style={{
              display: 'block',
              marginBottom: '1rem',
              color: 'var(--color-text)',
            }}
          />
          <button
            className="btn"
            onClick={handleImport}
            disabled={!file || importing}
          >
            {importing ? 'Importing...' : 'Import File'}
          </button>
        </div>

        {result && (
          <div style={{
            padding: '1rem',
            background: 'var(--color-bg)',
            borderRadius: '0.375rem',
            border: '1px solid var(--color-border)',
          }}>
            <h3 style={{ marginBottom: '0.75rem' }}>Import Result</h3>
            <p><strong>Document Hash:</strong> {result.documentHash.substring(0, 12)}...</p>
            <p><strong>New Observations:</strong> {result.observationsCreated}</p>
            <p><strong>Duplicates Skipped:</strong> {result.observationsDuplicate}</p>
            
            {result.errors.length > 0 && (
              <div style={{ marginTop: '1rem' }}>
                <strong style={{ color: 'var(--color-danger)' }}>Errors:</strong>
                <ul style={{ marginTop: '0.5rem', paddingLeft: '1.5rem' }}>
                  {result.errors.map((error, i) => (
                    <li key={i} style={{ color: 'var(--color-danger)' }}>{error}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="card">
        <h2>Supported Formats</h2>
        
        <div style={{ marginBottom: '1.5rem' }}>
          <h3 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>CSV</h3>
          <p style={{ fontSize: '0.875rem', color: 'var(--color-text-dim)' }}>
            Generic CSV files with configurable column mapping. Default columns: Date, Amount, Description.
          </p>
        </div>

        <div style={{ marginBottom: '1.5rem' }}>
          <h3 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>OFX/QFX</h3>
          <p style={{ fontSize: '0.875rem', color: 'var(--color-text-dim)' }}>
            Open Financial Exchange format supported by most US banks. Download from your bank's website.
          </p>
        </div>

        <div style={{ marginBottom: '1.5rem' }}>
          <h3 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>Email Alerts</h3>
          <p style={{ fontSize: '0.875rem', color: 'var(--color-text-dim)' }}>
            Transaction alert emails from your bank. Creates pending transactions that get matched when statements are imported.
          </p>
        </div>

        <div>
          <h3 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>PDF Statements</h3>
          <p style={{ fontSize: '0.875rem', color: 'var(--color-text-dim)' }}>
            PDF bank statements (requires custom parser configuration per bank format).
          </p>
        </div>
      </div>
    </div>
  );
}
