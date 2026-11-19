#!/usr/bin/env node
// One-off repair: merge a `pending` (bank-alert) transaction into the `posted`
// (statement) transaction it duplicates. Dry run by default; pass --apply to write.
//
//   node scripts/merge-pending-twins.mjs [--db /data/openenvelope.db] [--apply]
//
// A pair is merged only when: same account and sign, identical amount, dates within
// -3..+1 days of each other, compatible merchants, the posted row has no alert
// observation yet, and the pending row matches exactly ONE posted row.
// The posted row keeps its identity; the pending row's observations, category,
// envelope, notes and references are moved onto it and the pending row is deleted.
import Database from 'better-sqlite3';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const dbPath = args.includes('--db') ? args[args.indexOf('--db') + 1] : '/data/openenvelope.db';

function normalize(text) {
  return String(text).toUpperCase().replace(/^\s*-?\d{3,5}\s+/, '').replace(/[^A-Z0-9]/g, '');
}
// Keep in sync with src/server/lib/merchant-compat.ts
function compatible(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  const shorter = Math.min(na.length, nb.length);
  if (shorter < 5) return false;
  let common = 0;
  while (common < shorter && na[common] === nb[common]) common++;
  return common >= Math.min(8, shorter) || na.includes(nb.slice(0, 12)) || nb.includes(na.slice(0, 12));
}

const db = new Database(dbPath);
db.pragma('foreign_keys = ON');
const DAY = 86400000;

const pending = db.prepare("SELECT * FROM transactions WHERE state = 'pending'").all();
const postedRows = db.prepare("SELECT * FROM transactions WHERE state = 'posted'").all();
const obsInfo = db.prepare('SELECT adapter_name, is_statement FROM observations WHERE id = ?');

function hasAlertObservation(tx) {
  for (const id of JSON.parse(tx.observation_ids)) {
    const o = obsInfo.get(id);
    if (o && o.is_statement !== 1 && (o.adapter_name.startsWith('email-') || o.adapter_name.includes('alert'))) {
      return true;
    }
  }
  return false;
}

const plan = [];
const skipped = { none: 0, ambiguous: 0 };
const claimed = new Set();
for (const p of pending) {
  const twins = postedRows.filter(
    (q) =>
      q.household_id === p.household_id &&
      q.account_id === p.account_id &&
      q.amount_cents === p.amount_cents &&
      q.timestamp - p.timestamp >= -3 * DAY &&
      q.timestamp - p.timestamp <= 1 * DAY &&
      compatible(p.merchant_text, q.merchant_text) &&
      !hasAlertObservation(q) &&
      !claimed.has(q.id)
  );
  if (twins.length === 0) skipped.none++;
  else if (twins.length > 1) skipped.ambiguous++;
  else {
    claimed.add(twins[0].id);
    plan.push({ p, q: twins[0] });
  }
}

console.log(`pending: ${pending.length}, mergeable: ${plan.length}, no twin: ${skipped.none}, ambiguous: ${skipped.ambiguous}`);
if (!apply) {
  for (const { p, q } of plan.slice(0, 5)) {
    console.log(`  ${p.amount_cents} ${new Date(p.timestamp).toISOString().slice(0, 10)} "${p.merchant_text.slice(0, 24)}" -> "${q.merchant_text.slice(0, 24)}"`);
  }
  console.log('dry run only; pass --apply to merge');
  process.exit(0);
}

const merge = db.transaction(() => {
  for (const { p, q } of plan) {
    const obs = [...new Set([...JSON.parse(q.observation_ids), ...JSON.parse(p.observation_ids)])];
    db.prepare(
      `UPDATE transactions SET observation_ids = ?,
         category = COALESCE(category, ?), envelope_id = COALESCE(envelope_id, ?),
         notes = COALESCE(notes, ?), updated_at = ? WHERE id = ?`
    ).run(JSON.stringify(obs), p.category, p.envelope_id, p.notes, Date.now(), q.id);
    db.prepare('UPDATE transactions SET linked_transaction_id = ? WHERE linked_transaction_id = ?').run(q.id, p.id);
    db.prepare('UPDATE OR IGNORE context_links SET transaction_id = ? WHERE transaction_id = ?').run(q.id, p.id);
    db.prepare('DELETE FROM context_links WHERE transaction_id = ?').run(p.id);
    db.prepare('UPDATE OR IGNORE spent_attributions SET transaction_id = ? WHERE transaction_id = ?').run(q.id, p.id);
    db.prepare('DELETE FROM spent_attributions WHERE transaction_id = ?').run(p.id);
    db.prepare('UPDATE orders SET matched_transaction_id = ? WHERE matched_transaction_id = ?').run(q.id, p.id);
    db.prepare('DELETE FROM transactions WHERE id = ?').run(p.id);
  }
});
merge();
console.log(`merged ${plan.length} pending rows into their posted twins`);
console.log('integrity:', db.pragma('integrity_check')[0].integrity_check, '| fk violations:', db.pragma('foreign_key_check').length);
