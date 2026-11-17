import type Database from 'better-sqlite3';

export const LOCATION_POINT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const INBOUND_MAIL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const HOOK_EVENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function purgeOldLocationPoints(db: Database.Database, now = Date.now()): number {
  const cutoff = now - LOCATION_POINT_TTL_MS;
  const result = db.prepare('DELETE FROM location_points WHERE recorded_at < ?').run(cutoff);
  return result.changes;
}

export function purgeOldInboundMail(
  db: Database.Database,
  unlink?: (hash: string) => void,
  now = Date.now(),
): number {
  const cutoff = now - INBOUND_MAIL_TTL_MS;
  const rows = db.prepare(
    'SELECT id, document_hash FROM inbound_mail WHERE received_at < ?',
  ).all(cutoff) as Array<{ id: string; document_hash: string }>;
  if (rows.length === 0) return 0;
  const deleteMail = db.prepare('DELETE FROM inbound_mail WHERE id = ?');
  const remaining = db.prepare('SELECT 1 as ok FROM inbound_mail WHERE document_hash = ? LIMIT 1');
  const deleteDoc = db.prepare('DELETE FROM raw_documents WHERE hash = ?');
  const tx = db.transaction(() => {
    for (const row of rows) {
      deleteMail.run(row.id);
      const still = remaining.get(row.document_hash) as { ok: number } | undefined;
      if (!still) {
        deleteDoc.run(row.document_hash);
        unlink?.(row.document_hash);
      }
    }
  });
  tx();
  return rows.length;
}

export function purgeOldHookEvents(db: Database.Database, now = Date.now()): number {
  const cutoff = now - HOOK_EVENT_TTL_MS;
  const result = db.prepare('DELETE FROM ingest_hook_events WHERE received_at < ?').run(cutoff);
  return result.changes;
}
