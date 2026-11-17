import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initDatabase } from '../../src/server/db/database.js';

describe('src/scripts/detect-transfers.ts CLI', () => {
  it('links transfers and resolves stale possible_transfer reviews', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'detect-xfer-cli-'));
    const dbPath = join(tmpDir, 'openenvelope.db');
    const db = initDatabase(dbPath);
    try {
      const now = Date.now();
      db.prepare(`
        INSERT INTO accounts (id, name, aliases, account_group, created_at)
        VALUES
          ('bank', 'Bank', '["bank"]', 'budget', ?),
          ('card', 'Card', '["card"]', 'credit', ?)
      `).run(now, now);
      db.prepare(`
        INSERT INTO raw_documents (hash, filename, mime_type, uploaded_at, size_bytes)
        VALUES ('doc', 'stmt.txt', 'text/plain', ?, 10)
      `).run(now);
      db.prepare(`
        INSERT INTO observations (
          id, document_hash, account_hint, amount_cents, currency, timestamp,
          merchant_text, kind, adapter_name, is_statement, created_at
        ) VALUES (?, 'doc', 'bank', -12345, 'SGD', ?, 'CARD PAYMENT', 'transfer', 'ocbc-360', 1, ?)
      `).run('obs-bank', now, now);
      db.prepare(`
        INSERT INTO transactions (
          id, account_id, amount_cents, currency, timestamp,
          merchant_text, state, observation_ids, created_at, updated_at
        ) VALUES
          ('tx-bank', 'bank', -12345, 'SGD', ?, 'CARD PAYMENT TO OCBC 90N', 'posted', ?, ?, ?),
          ('tx-card', 'card', 12345, 'SGD', ?, 'PAYMENT RECEIVED', 'posted', '[]', ?, ?)
      `).run(now, JSON.stringify(['obs-bank']), now, now, now + 1000, now, now);
      db.prepare(`
        INSERT INTO review_queue (id, observation_id, document_hash, reason, detail, created_at)
        VALUES ('legacy-xfer', 'obs-bank', 'doc', 'possible_transfer', 'Possible transfer pair: CARD PAYMENT and PAYMENT RECEIVED (Card)', ?)
      `).run(now);
      db.close();

      const tsx = join(process.cwd(), 'node_modules/.bin/tsx');
      const output = execFileSync(tsx, ['src/scripts/detect-transfers.ts'], {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_PATH: dbPath },
        encoding: 'utf8',
      });
      const summary = JSON.parse(output) as {
        linkedPairs: number;
        reviewsResolved: number;
      };
      expect(summary.linkedPairs).toBe(1);
      expect(summary.reviewsResolved).toBeGreaterThanOrEqual(1);

      const verify = initDatabase(dbPath);
      const bank = verify.prepare("SELECT linked_transaction_id FROM transactions WHERE id = 'tx-bank'").get() as {
        linked_transaction_id: string | null;
      };
      expect(bank.linked_transaction_id).toBe('tx-card');
      const review = verify.prepare("SELECT resolved FROM review_queue WHERE id = 'legacy-xfer'").get() as {
        resolved: number;
      };
      expect(review.resolved).toBe(1);
      verify.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
