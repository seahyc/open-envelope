import type Database from 'better-sqlite3';
import { DEFAULT_HOUSEHOLD_ID, TENANT_TABLES } from '../lib/tenancy.js';

function tableExists(db: Database.Database, name: string): boolean {
  const row = db.prepare(
    "SELECT 1 as ok FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(name) as { ok: number } | undefined;
  return Boolean(row);
}

function columnsOf(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

function addHouseholdColumn(db: Database.Database, table: string): void {
  if (!tableExists(db, table)) return;
  if (columnsOf(db, table).includes('household_id')) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN household_id TEXT NOT NULL DEFAULT '${DEFAULT_HOUSEHOLD_ID}'`);
}

function hasIndex(db: Database.Database, name: string): boolean {
  const row = db.prepare(
    "SELECT 1 as ok FROM sqlite_master WHERE type = 'index' AND name = ?"
  ).get(name) as { ok: number } | undefined;
  return Boolean(row);
}

/**
 * Stamp the single existing household as tenant #1 (`hh-1`).
 * ADD COLUMN keeps every other value byte-for-byte. Rebuilds only UNIQUE/PK
 * that would block a second household. Public caches (geocode, ACRA) stay global.
 */
export function applyTenancyV13(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS households (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'SGD',
      budget_start_date TEXT,
      onboarding_step TEXT NOT NULL DEFAULT 'welcome',
      onboarding_payload TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    )
  `);

  const now = Date.now();
  const existing = db.prepare('SELECT id FROM households WHERE id = ?').get(DEFAULT_HOUSEHOLD_ID) as
    | { id: string }
    | undefined;
  if (!existing) {
    const memberCount = tableExists(db, 'household_members')
      ? (db.prepare('SELECT COUNT(*) as n FROM household_members').get() as { n: number }).n
      : 0;
    const accountCount = tableExists(db, 'accounts')
      ? (db.prepare('SELECT COUNT(*) as n FROM accounts').get() as { n: number }).n
      : 0;
    const step = memberCount > 0 || accountCount > 0 ? 'complete' : 'welcome';

    let startDate: string | null = null;
    if (tableExists(db, 'accounts')) {
      const opened = db.prepare(
        'SELECT MIN(opened_at) as t FROM accounts WHERE opened_at IS NOT NULL'
      ).get() as { t: number | null };
      if (opened.t) startDate = new Date(opened.t).toISOString().slice(0, 10);
    }

    db.prepare(`
      INSERT INTO households (
        id, name, currency, budget_start_date, onboarding_step, onboarding_payload,
        created_at, updated_at, deleted_at
      ) VALUES (?, ?, 'SGD', ?, ?, NULL, ?, ?, NULL)
    `).run(DEFAULT_HOUSEHOLD_ID, 'Household', startDate, step, now, now);
  }

  for (const table of TENANT_TABLES) {
    addHouseholdColumn(db, table);
  }

  rebuildHouseholdMembers(db);
  rebuildMerchantNormalizations(db);
  rebuildMerchantMemory(db);
  rebuildOrders(db);
  rebuildAdapterConfigs(db);

  const indexSql: Array<[string, string, string]> = [
    ['idx_accounts_household', 'accounts', 'CREATE INDEX IF NOT EXISTS idx_accounts_household ON accounts(household_id)'],
    ['idx_transactions_household', 'transactions', 'CREATE INDEX IF NOT EXISTS idx_transactions_household ON transactions(household_id, timestamp)'],
    ['idx_envelopes_household', 'envelopes', 'CREATE INDEX IF NOT EXISTS idx_envelopes_household ON envelopes(household_id)'],
    ['idx_observations_household', 'observations', 'CREATE INDEX IF NOT EXISTS idx_observations_household ON observations(household_id)'],
    ['idx_members_household', 'household_members', 'CREATE INDEX IF NOT EXISTS idx_members_household ON household_members(household_id)'],
    ['idx_review_household', 'review_queue', 'CREATE INDEX IF NOT EXISTS idx_review_household ON review_queue(household_id, resolved)'],
    ['idx_raw_documents_household', 'raw_documents', 'CREATE INDEX IF NOT EXISTS idx_raw_documents_household ON raw_documents(household_id)'],
  ];
  for (const [name, table, sql] of indexSql) {
    if (tableExists(db, table) && !hasIndex(db, name)) db.exec(sql);
  }
}

function rebuildHouseholdMembers(db: Database.Database): void {
  if (!tableExists(db, 'household_members')) return;
  const cols = columnsOf(db, 'household_members');
  if (cols.includes('household_id') && uniqueIsComposite(db, 'household_members', ['household_id', 'name'])) {
    return;
  }

  db.exec(`
    CREATE TABLE household_members_v13 (
      id TEXT PRIMARY KEY,
      household_id TEXT NOT NULL DEFAULT '${DEFAULT_HOUSEHOLD_ID}',
      name TEXT NOT NULL COLLATE NOCASE,
      email TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(household_id, name),
      FOREIGN KEY (household_id) REFERENCES households(id)
    );
    INSERT INTO household_members_v13 (id, household_id, name, email, created_at)
    SELECT id, COALESCE(household_id, '${DEFAULT_HOUSEHOLD_ID}'), name, email, created_at
    FROM household_members;
    DROP TABLE household_members;
    ALTER TABLE household_members_v13 RENAME TO household_members;
    CREATE INDEX IF NOT EXISTS idx_household_members_name ON household_members(name);
    CREATE INDEX IF NOT EXISTS idx_members_household ON household_members(household_id);
  `);
}

function rebuildMerchantNormalizations(db: Database.Database): void {
  if (!tableExists(db, 'merchant_normalizations')) return;
  if (uniqueIsComposite(db, 'merchant_normalizations', ['household_id', 'raw_merchant'])) return;

  db.exec(`
    CREATE TABLE merchant_normalizations_v13 (
      id TEXT PRIMARY KEY,
      household_id TEXT NOT NULL DEFAULT '${DEFAULT_HOUSEHOLD_ID}',
      raw_merchant TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(household_id, raw_merchant)
    );
    INSERT INTO merchant_normalizations_v13 (id, household_id, raw_merchant, normalized_name, source, created_at)
    SELECT id, COALESCE(household_id, '${DEFAULT_HOUSEHOLD_ID}'), raw_merchant, normalized_name, source, created_at
    FROM merchant_normalizations;
    DROP TABLE merchant_normalizations;
    ALTER TABLE merchant_normalizations_v13 RENAME TO merchant_normalizations;
    CREATE INDEX IF NOT EXISTS idx_merchant_normalizations_raw
      ON merchant_normalizations(raw_merchant);
  `);
}

function rebuildMerchantMemory(db: Database.Database): void {
  if (!tableExists(db, 'merchant_memory')) return;
  if (uniqueIsComposite(db, 'merchant_memory', ['household_id', 'merchant_key', 'category_id'])) return;

  db.exec(`
    CREATE TABLE merchant_memory_v13 (
      household_id TEXT NOT NULL DEFAULT '${DEFAULT_HOUSEHOLD_ID}',
      merchant_key TEXT NOT NULL,
      category_id TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      flag_ask INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (household_id, merchant_key, category_id)
    );
    INSERT INTO merchant_memory_v13 (household_id, merchant_key, category_id, count, flag_ask)
    SELECT COALESCE(household_id, '${DEFAULT_HOUSEHOLD_ID}'), merchant_key, category_id, count, flag_ask
    FROM merchant_memory;
    DROP TABLE merchant_memory;
    ALTER TABLE merchant_memory_v13 RENAME TO merchant_memory;
  `);
}

function rebuildOrders(db: Database.Database): void {
  if (!tableExists(db, 'orders')) return;
  if (uniqueIsComposite(db, 'orders', ['household_id', 'merchant', 'order_ref'])) return;

  const cols = columnsOf(db, 'orders');
  const sourceSelect = cols.includes('source') ? 'source' : "'email'";

  db.exec(`
    CREATE TABLE orders_v13 (
      id TEXT PRIMARY KEY,
      household_id TEXT NOT NULL DEFAULT '${DEFAULT_HOUSEHOLD_ID}',
      merchant TEXT NOT NULL,
      order_ref TEXT NOT NULL,
      member_id TEXT,
      total_cents INTEGER,
      currency TEXT NOT NULL DEFAULT 'SGD',
      ordered_at INTEGER,
      source_hash TEXT,
      created_at INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'email',
      UNIQUE(household_id, merchant, order_ref),
      FOREIGN KEY (member_id) REFERENCES household_members(id)
    );
    INSERT INTO orders_v13 (
      id, household_id, merchant, order_ref, member_id, total_cents, currency,
      ordered_at, source_hash, created_at, source
    )
    SELECT id, COALESCE(household_id, '${DEFAULT_HOUSEHOLD_ID}'), merchant, order_ref, member_id,
           total_cents, currency, ordered_at, source_hash, created_at, ${sourceSelect}
    FROM orders;
    DROP TABLE orders;
    ALTER TABLE orders_v13 RENAME TO orders;
  `);
}

function rebuildAdapterConfigs(db: Database.Database): void {
  if (!tableExists(db, 'adapter_configs')) return;
  if (uniqueIsComposite(db, 'adapter_configs', ['household_id', 'name'])) return;

  db.exec(`
    CREATE TABLE adapter_configs_v13 (
      household_id TEXT NOT NULL DEFAULT '${DEFAULT_HOUSEHOLD_ID}',
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      config TEXT NOT NULL,
      PRIMARY KEY (household_id, name)
    );
    INSERT INTO adapter_configs_v13 (household_id, name, type, config)
    SELECT COALESCE(household_id, '${DEFAULT_HOUSEHOLD_ID}'), name, type, config
    FROM adapter_configs;
    DROP TABLE adapter_configs;
    ALTER TABLE adapter_configs_v13 RENAME TO adapter_configs;
  `);
}

function uniqueIsComposite(db: Database.Database, table: string, expected: string[]): boolean {
  const indexes = db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string; unique: number }>;
  for (const idx of indexes) {
    if (!idx.unique) continue;
    const cols = (db.prepare(`PRAGMA index_info(${idx.name})`).all() as Array<{ name: string }>).map((c) => c.name);
    if (cols.length === expected.length && expected.every((name, i) => cols[i] === name)) {
      return true;
    }
  }
  const pk = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>)
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
  return pk.length === expected.length && expected.every((name, i) => pk[i] === name);
}
