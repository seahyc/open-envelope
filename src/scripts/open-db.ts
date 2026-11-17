import Database from 'better-sqlite3';
import { runMigrations } from '../server/db/migrations.js';

export function openConfiguredDatabase(): Database.Database {
  const databasePath = process.env.DATABASE_PATH || './data/openenvelope.db';
  const db = Database(databasePath);
  runMigrations(db);
  return db;
}
