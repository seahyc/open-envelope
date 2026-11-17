import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/server/db/migrations.js';

describe('migration v9 merchant_enrichments', () => {
  it('creates the cache table with fetched_at', () => {
    const db = new Database(':memory:');
    runMigrations(db, { quiet: true, throughVersion: 9 });
    const version = db.prepare('SELECT MAX(version) as version FROM schema_migrations').get() as { version: number };
    expect(version.version).toBe(9);
    const cols = db.prepare('PRAGMA table_info(merchant_enrichments)').all() as Array<{ name: string }>;
    expect(cols.map((col) => col.name)).toEqual([
      'merchant_key',
      'payee_name',
      'uen',
      'source',
      'registered_name',
      'entity_status',
      'ssic_code',
      'ssic_description',
      'web_description',
      'source_urls',
      'fetched_at',
    ]);
    db.close();
  });

  it('adds registered address and incorporation date in v17', () => {
    const db = new Database(':memory:');
    runMigrations(db, { quiet: true });
    const version = db.prepare('SELECT MAX(version) as version FROM schema_migrations').get() as { version: number };
    expect(version.version).toBeGreaterThanOrEqual(17);
    const cols = db.prepare('PRAGMA table_info(merchant_enrichments)').all() as Array<{ name: string }>;
    expect(cols.map((col) => col.name)).toContain('registered_address');
    expect(cols.map((col) => col.name)).toContain('incorporation_date');
    db.close();
  });
});
