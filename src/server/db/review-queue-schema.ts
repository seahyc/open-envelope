import type Database from 'better-sqlite3';

export function createReviewQueueTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS review_queue (
      id TEXT PRIMARY KEY,
      observation_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      detail TEXT,
      resolved INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER,
      FOREIGN KEY (observation_id) REFERENCES observations(id)
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_review_queue_resolved 
    ON review_queue(resolved, created_at DESC)
  `);
}
