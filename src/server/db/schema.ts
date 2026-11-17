export const schema = `
CREATE TABLE IF NOT EXISTS raw_documents (
  hash TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  uploaded_at INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  document_hash TEXT NOT NULL,
  account_hint TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  fx_amount_cents INTEGER,
  fx_currency TEXT,
  timestamp INTEGER NOT NULL,
  merchant_text TEXT NOT NULL,
  reference TEXT,
  kind TEXT NOT NULL,
  adapter_name TEXT NOT NULL,
  is_statement INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (document_hash) REFERENCES raw_documents(hash)
);

CREATE INDEX IF NOT EXISTS idx_observations_document ON observations(document_hash);
CREATE INDEX IF NOT EXISTS idx_observations_account ON observations(account_hint);
CREATE INDEX IF NOT EXISTS idx_observations_timestamp ON observations(timestamp);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  aliases TEXT NOT NULL,
  account_group TEXT NOT NULL,
  opened_at INTEGER,
  closed_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  fx_amount_cents INTEGER,
  fx_currency TEXT,
  timestamp INTEGER NOT NULL,
  merchant_text TEXT NOT NULL,
  normalized_merchant TEXT,
  state TEXT NOT NULL,
  category TEXT,
  envelope_id TEXT,
  linked_transaction_id TEXT,
  observation_ids TEXT NOT NULL,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  FOREIGN KEY (linked_transaction_id) REFERENCES transactions(id)
);

CREATE INDEX IF NOT EXISTS idx_transactions_account ON transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_transactions_timestamp ON transactions(timestamp);
CREATE INDEX IF NOT EXISTS idx_transactions_state ON transactions(state);

CREATE TABLE IF NOT EXISTS statement_periods (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  start_date INTEGER NOT NULL,
  end_date INTEGER NOT NULL,
  opening_balance_cents INTEGER NOT NULL,
  closing_balance_cents INTEGER NOT NULL,
  document_hash TEXT,
  reconciled_at INTEGER,
  discrepancy_cents INTEGER,
  status TEXT NOT NULL DEFAULT 'balanced',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  FOREIGN KEY (document_hash) REFERENCES raw_documents(hash)
);

CREATE INDEX IF NOT EXISTS idx_statement_periods_account ON statement_periods(account_id);

CREATE TABLE IF NOT EXISTS merchant_rules (
  id TEXT PRIMARY KEY,
  pattern TEXT NOT NULL,
  category TEXT NOT NULL,
  envelope_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS envelopes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner TEXT NOT NULL,
  monthly_target_cents INTEGER,
  color TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS budget_allocations (
  id TEXT PRIMARY KEY,
  envelope_id TEXT NOT NULL,
  month TEXT NOT NULL,
  allocated_cents INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (envelope_id) REFERENCES envelopes(id),
  UNIQUE(envelope_id, month)
);

CREATE INDEX IF NOT EXISTS idx_budget_allocations_month ON budget_allocations(month);

CREATE TABLE IF NOT EXISTS adapter_configs (
  name TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  config TEXT NOT NULL
);
`;
