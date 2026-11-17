import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { runMigrations } from '../../src/server/db/migrations.js';

describe('Migration v3 - normalized_merchant', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'migration-test-'));
    dbPath = join(tmpDir, 'test.db');
  });

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('adds normalized_merchant column to DB without it and preserves linked transactions', () => {
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
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        aliases TEXT NOT NULL,
        account_group TEXT NOT NULL,
        opened_at INTEGER,
        closed_at INTEGER,
        created_at INTEGER NOT NULL
      );
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        currency TEXT NOT NULL,
        fx_amount_cents INTEGER,
        fx_currency TEXT,
        timestamp INTEGER NOT NULL,
        merchant_text TEXT NOT NULL,
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
    `);

    db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, 'initial_schema', ?)").run(Date.now());
    db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (2, 'review_queue_document_hash', ?)").run(Date.now());

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

    db.prepare(`
      INSERT INTO transactions (id, account_id, amount_cents, currency, timestamp, merchant_text, 
        state, observation_ids, created_at, updated_at)
      VALUES ('tx3', 'acc1', -2500, 'USD', ?, 'Purchase', 'posted', '[]', ?, ?)
    `).run(now, now, now);

    db.prepare('UPDATE transactions SET linked_transaction_id = ? WHERE id = ?').run('tx2', 'tx1');
    db.prepare('UPDATE transactions SET linked_transaction_id = ? WHERE id = ?').run('tx1', 'tx2');

    const beforeColumns = db.prepare('PRAGMA table_info(transactions)').all() as Array<{ name: string }>;
    const hasColumnBefore = beforeColumns.some(col => col.name === 'normalized_merchant');
    expect(hasColumnBefore).toBe(false);

    runMigrations(db);

    const afterColumns = db.prepare('PRAGMA table_info(transactions)').all() as Array<{ name: string }>;
    const hasColumnAfter = afterColumns.some(col => col.name === 'normalized_merchant');
    expect(hasColumnAfter).toBe(true);

    const tx1 = db.prepare('SELECT * FROM transactions WHERE id = ?').get('tx1') as any;
    expect(tx1.linked_transaction_id).toBe('tx2');
    expect(tx1.amount_cents).toBe(-5000);

    const tx2 = db.prepare('SELECT * FROM transactions WHERE id = ?').get('tx2') as any;
    expect(tx2.linked_transaction_id).toBe('tx1');
    expect(tx2.amount_cents).toBe(5000);

    const tx3 = db.prepare('SELECT * FROM transactions WHERE id = ?').get('tx3') as any;
    expect(tx3.amount_cents).toBe(-2500);

    const txCount = db.prepare('SELECT COUNT(*) as count FROM transactions').get() as { count: number };
    expect(txCount.count).toBe(3);

    runMigrations(db);

    const finalCount = db.prepare('SELECT COUNT(*) as count FROM transactions').get() as { count: number };
    expect(finalCount.count).toBe(3);

    db.close();
  });

  it('is idempotent when column already exists', () => {
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
      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        currency TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        merchant_text TEXT NOT NULL,
        normalized_merchant TEXT,
        state TEXT NOT NULL,
        observation_ids TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, 'initial_schema', ?)").run(Date.now());
    db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (2, 'review_queue_document_hash', ?)").run(Date.now());

    runMigrations(db);

    const columns = db.prepare('PRAGMA table_info(transactions)').all() as Array<{ name: string }>;
    const normalizedCount = columns.filter(col => col.name === 'normalized_merchant').length;
    expect(normalizedCount).toBe(1);

    db.close();
  });

  it('recovers from leftover transactions_new table', () => {
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
      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        currency TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        merchant_text TEXT NOT NULL,
        state TEXT NOT NULL,
        observation_ids TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    db.exec(`
      CREATE TABLE transactions_new (
        id TEXT PRIMARY KEY,
        leftover TEXT
      );
    `);

    db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, 'initial_schema', ?)").run(Date.now());
    db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (2, 'review_queue_document_hash', ?)").run(Date.now());

    runMigrations(db);

    const columns = db.prepare('PRAGMA table_info(transactions)').all() as Array<{ name: string }>;
    const hasColumn = columns.some(col => col.name === 'normalized_merchant');
    expect(hasColumn).toBe(true);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='transactions_new'").all();
    expect(tables.length).toBe(0);

    db.close();
  });
});
