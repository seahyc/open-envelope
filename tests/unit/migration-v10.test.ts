import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/server/db/migrations.js';

const TABLES = [
  'location_devices',
  'location_points',
  'place_visits',
  'geocode_cache',
  'member_calendar_feeds',
  'calendar_events',
  'orders',
  'order_items',
  'context_links',
  'spent_attributions',
];

describe('migration v10 context_signals', () => {
  it('creates context tables', () => {
    const db = new Database(':memory:');
    runMigrations(db, { quiet: true });
    const version = db.prepare('SELECT MAX(version) as version FROM schema_migrations').get() as { version: number };
    expect(version.version).toBeGreaterThanOrEqual(10);
    const names = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    ).all() as Array<{ name: string }>).map((row) => row.name);
    for (const table of TABLES) {
      expect(names).toContain(table);
    }
    const linkCols = (db.prepare('PRAGMA table_info(context_links)').all() as Array<{ name: string }>)
      .map((col) => col.name);
    expect(linkCols).toEqual(expect.arrayContaining([
      'id', 'transaction_id', 'kind', 'source_id', 'snippet', 'proposed_split', 'status',
    ]));
    db.close();
  });
});
