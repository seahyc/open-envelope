import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { initDatabase } from '../../src/server/db/database.js';

describe('Migration v2 - Production Schema Compatibility', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'migration-v2-test-'));
    dbPath = join(tmpDir, 'test.db');
  });

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('migrates from commit 4353a5e schema (before review_queue existed)', () => {
    const db = Database(dbPath);
    
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `);

    db.exec(`
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

      CREATE TABLE IF NOT EXISTS envelopes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner TEXT NOT NULL,
        monthly_target_cents INTEGER,
        color TEXT,
        created_at INTEGER NOT NULL
      );
    `);

    db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, 'initial_schema', ?)").run(Date.now());

    db.prepare(`
      INSERT INTO accounts (id, name, aliases, account_group, created_at)
      VALUES ('acc1', 'Account 1', '["acc1"]', 'budget', ?)
    `).run(Date.now());

    db.prepare(`
      INSERT INTO accounts (id, name, aliases, account_group, created_at)
      VALUES ('acc2', 'Account 2', '["acc2"]', 'budget', ?)
    `).run(Date.now());

    const now = Date.now();
    db.prepare(`
      INSERT INTO transactions (id, account_id, amount_cents, currency, timestamp, merchant_text, 
        state, observation_ids, created_at, updated_at)
      VALUES ('tx1', 'acc1', -5000, 'USD', ?, 'Transfer Out', 'posted', '[]', ?, ?)
    `).run(now, now, now);

    db.prepare(`
      INSERT INTO transactions (id, account_id, amount_cents, currency, timestamp, merchant_text, 
        state, observation_ids, created_at, updated_at)
      VALUES ('tx2', 'acc2', 5000, 'USD', ?, 'Transfer In', 'posted', '[]', ?, ?)
    `).run(now, now, now);

    db.prepare('UPDATE transactions SET linked_transaction_id = ? WHERE id = ?').run('tx2', 'tx1');
    db.prepare('UPDATE transactions SET linked_transaction_id = ? WHERE id = ?').run('tx1', 'tx2');

    db.prepare(`
      INSERT INTO transactions (id, account_id, amount_cents, currency, timestamp, merchant_text, 
        state, observation_ids, created_at, updated_at)
      VALUES ('tx3', 'acc1', -2500, 'SGD', ?, 'Pending Purchase', 'pending', '[]', ?, ?)
    `).run(now, now, now);

    db.prepare(`
      INSERT INTO envelopes (id, name, owner, created_at)
      VALUES ('env1', 'Groceries', 'shared', ?)
    `).run(Date.now());

    db.close();

    const db2 = initDatabase(dbPath);

    const tx1 = db2.prepare('SELECT * FROM transactions WHERE id = ?').get('tx1') as any;
    expect(tx1.linked_transaction_id).toBe('tx2');
    expect(tx1.amount_cents).toBe(-5000);

    const tx2 = db2.prepare('SELECT * FROM transactions WHERE id = ?').get('tx2') as any;
    expect(tx2.linked_transaction_id).toBe('tx1');
    expect(tx2.amount_cents).toBe(5000);

    const tx3 = db2.prepare('SELECT * FROM transactions WHERE id = ?').get('tx3') as any;
    expect(tx3.state).toBe('pending');
    expect(tx3.amount_cents).toBe(-2500);

    const env = db2.prepare('SELECT * FROM envelopes WHERE id = ?').get('env1') as any;
    expect(env.name).toBe('Groceries');

    const tables = db2.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('review_queue', 'merchant_normalizations')").all() as Array<{ name: string }>;
    expect(tables.length).toBe(2);

    const version = db2.prepare('SELECT MAX(version) as version FROM schema_migrations').get() as { version: number };
    expect(version.version).toBeGreaterThanOrEqual(2);

    db2.close();

    const db3 = initDatabase(dbPath);
    
    const txCount = db3.prepare('SELECT COUNT(*) as count FROM transactions').get() as { count: number };
    expect(txCount.count).toBe(3);

    db3.close();
  });
});
