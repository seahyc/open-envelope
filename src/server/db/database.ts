import Database from 'better-sqlite3';
import { runMigrations } from './migrations.js';
import fs from 'fs';
import path from 'path';

export function initDatabase(dbPath: string, options: { quiet?: boolean } = {}): Database.Database {
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = new Database(dbPath);
  runMigrations(db, options);
  
  return db;
}

export function closeDatabase(db: Database.Database): void {
  db.close();
}
