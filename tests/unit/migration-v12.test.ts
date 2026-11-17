import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/server/db/migrations.js';

describe('migration v12 context_connections', () => {
  it('adds mailboxes, inbound mail, extension tokens, and calendar error columns', () => {
    const db = new Database(':memory:');
    runMigrations(db, { quiet: true });
    const version = db.prepare('SELECT MAX(version) as version FROM schema_migrations').get() as { version: number };
    expect(version.version).toBeGreaterThanOrEqual(12);
    const names = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all() as Array<{ name: string }>).map((row) => row.name);
    expect(names).toEqual(expect.arrayContaining([
      'ingest_mailboxes',
      'inbound_mail',
      'extension_tokens',
    ]));
    const calCols = (db.prepare('PRAGMA table_info(member_calendar_feeds)').all() as Array<{ name: string }>)
      .map((col) => col.name);
    expect(calCols).toEqual(expect.arrayContaining(['last_error', 'last_fetched_at']));
    const orderCols = (db.prepare('PRAGMA table_info(orders)').all() as Array<{ name: string }>)
      .map((col) => col.name);
    expect(orderCols).toContain('source');
    db.close();
  });
});
