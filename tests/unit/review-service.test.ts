import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { join } from 'path';
import { runMigrations } from '../../src/server/db/migrations.js';
import { ReviewService, CAPITAL_TRANSFER_CATEGORY } from '../../src/server/services/review-service.js';
import { NO_RESEARCH_MATCH } from '../../src/server/services/ssic-guess.js';
import { CategoriserService } from '../../src/server/categoriser/service.js';
import { MerchantEnrichmentService, type AcraLookup } from '../../src/server/services/merchant-enrichment-service.js';
import { loadCategorySchema } from '../../src/server/categoriser/schema.js';
import { normalizeMerchantKey } from '../../src/server/categoriser/normalize.js';
import { seedUiFixtures, UI_SEED_CONTRACTOR } from '../../src/server/services/ui-seed.js';

const schema = loadCategorySchema(join(process.cwd(), 'config/categories.default.json'));
const HAWKER = 'exp.food.dining.hawker';
const GROCERIES = 'exp.food.groceries';

function insertAccount(db: Database.Database): void {
  db.prepare(`
    INSERT INTO accounts (id, name, aliases, account_group, created_at)
    VALUES ('acc-1', 'Joint POSB', '["posb"]', 'budget', ?)
  `).run(Date.now());
}

function insertTx(db: Database.Database, id: string, merchant: string, amount: number): void {
  const now = Date.now();
  db.prepare(`
    INSERT INTO transactions (
      id, account_id, amount_cents, currency, timestamp, merchant_text,
      state, observation_ids, created_at, updated_at
    ) VALUES (?, 'acc-1', ?, 'SGD', ?, ?, 'posted', '[]', ?, ?)
  `).run(id, amount, now, merchant, now, now);
}

function insertReview(db: Database.Database, txId: string, categoryId: string, confidence: number): void {
  db.prepare(`
    INSERT INTO review_queue (id, observation_id, document_hash, reason, detail, created_at)
    VALUES (?, NULL, NULL, 'low_confidence_category', ?, ?)
  `).run(
    `cat-${txId}`,
    JSON.stringify({ transactionId: txId, categoryId, confidence, rationale: 'test' }),
    Date.now()
  );
}

describe('ReviewService', () => {
  let db: Database.Database;
  let service: ReviewService;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, { quiet: true });
    insertAccount(db);
    service = new ReviewService(db, new CategoriserService(db, { schema }));
  });

  it('lists open items grouped by merchant including cat-* rows without observations', () => {
    insertTx(db, 'tx-k1', 'Kopi Corner', -480);
    insertTx(db, 'tx-k2', 'Kopi Corner', -360);
    insertTx(db, 'tx-f1', 'FairMart', -1890);
    insertReview(db, 'tx-k1', HAWKER, 0.62);
    insertReview(db, 'tx-k2', HAWKER, 0.58);
    insertReview(db, 'tx-f1', GROCERIES, 0.88);

    const listed = service.list();
    expect(listed.count).toBe(3);
    const kopi = listed.groups.find((group) => group.merchantText === 'Kopi Corner');
    expect(kopi?.count).toBe(2);
    expect(kopi?.suggestedCategoryId).toBe(HAWKER);
    expect(listed.items.map((item) => item.transactionId).sort()).toEqual(['tx-f1', 'tx-k1', 'tx-k2']);
  });

  it('resolves one item', () => {
    insertTx(db, 'tx-k1', 'Kopi Corner', -480);
    insertReview(db, 'tx-k1', HAWKER, 0.62);
    service.resolve('cat-tx-k1', { categoryId: HAWKER });
    expect(db.prepare('SELECT category FROM transactions WHERE id = ?').get('tx-k1')).toEqual({ category: HAWKER });
    expect(service.list().count).toBe(0);
  });

  it('bulk-accepts with an always-use merchant rule and undoes', () => {
    insertTx(db, 'tx-k1', 'Kopi Corner', -480);
    insertTx(db, 'tx-k2', 'Kopi Corner', -360);
    insertReview(db, 'tx-k1', HAWKER, 0.62);
    insertReview(db, 'tx-k2', HAWKER, 0.58);

    const bulk = service.bulk(['cat-tx-k1', 'cat-tx-k2'], { categoryId: HAWKER, rememberRule: true });
    expect(bulk.accepted).toBe(2);
    expect(service.list().count).toBe(0);
    expect(db.prepare('SELECT pattern, category FROM merchant_rules').get()).toEqual({
      pattern: 'Kopi Corner',
      category: HAWKER,
    });

    const undone = service.undo(bulk.undoId);
    expect(undone.restored).toBe(2);
    expect(service.list().count).toBe(2);
    expect(db.prepare('SELECT COUNT(*) as c FROM merchant_rules').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT category FROM transactions WHERE id = ?').get('tx-k1')).toEqual({ category: null });
  });

  it('lists items whose detail is not JSON', () => {
    db.prepare(`
      INSERT INTO review_queue (id, observation_id, document_hash, reason, detail, created_at)
      VALUES ('plain-1', NULL, NULL, 'possible_transfer', 'Synthetic review item', ?)
    `).run(Date.now());

    const listed = service.list();
    expect(listed.count).toBe(1);
    expect(listed.items[0]?.id).toBe('plain-1');
    expect(listed.items[0]?.detail).toBeNull();
  });

  it('surfaces ACRA enrichment on the review item', () => {
    const merchant = 'FAST PAYMENT via PayNow-UEN to ABOVE ALL ENTERP OTHR-OTHR';
    insertTx(db, 'tx-paynow', merchant, -1850);
    insertReview(db, 'tx-paynow', HAWKER, 0.51);
    db.prepare(`
      INSERT INTO merchant_enrichments (
        merchant_key, payee_name, uen, source, registered_name, entity_status,
        ssic_code, ssic_description, web_description, source_urls, fetched_at
      ) VALUES (?, 'ABOVE ALL ENTERP', NULL, 'acra', 'ABOVE ALL ENTERPRISE', 'Live Company',
        '56112', 'Cafes', NULL, '[]', ?)
    `).run(normalizeMerchantKey(merchant), Date.now());
    const item = service.list().items.find((row) => row.transactionId === 'tx-paynow');
    expect(item?.enrichmentLine).toBe('ACRA: ABOVE ALL ENTERPRISE — SSIC 56112 Cafes');
    expect(item?.enrichmentSource).toBe('acra');
    expect(item?.probablyWas).toBe('A meal or kopi at a coffee shop');
    expect(item?.thatDay).toBe('That day: nothing on your calendars · no location recorded');
    expect(item?.suggestedPayee).toBe('Above All Enterprise');
    expect(item?.researchPending).toBe(false);
    expect(item?.suggestedReason).toMatch(/coffee shop/i);
  });

  it('hides the pre-research guess on an opaque payee until research completes', () => {
    const merchant = 'FAST PAYMENT via PayNow to LIM AH HOCK OTHR-OTHR';
    insertTx(db, 'tx-con', merchant, -350000);
    insertReview(db, 'tx-con', 'exp.housing.utilities', 0.41);
    const listed = service.list();
    const item = listed.items.find((row) => row.transactionId === 'tx-con');
    expect(item?.researchPending).toBe(true);
    expect(item?.suggestedCategoryId).toBeNull();
    expect(item?.suggestedReason).toBe('');
    const group = listed.groups.find((entry) => entry.merchantText === merchant);
    expect(group?.suggestedCategoryId).toBeNull();
    expect(group?.suggestedCategoryLabel).toBeNull();
  });

  it('hides seeded opaque guesses until research, including the group label', () => {
    seedUiFixtures(db, { reviews: true });
    const listed = service.list();
    const contractor = listed.items.find((row) => row.merchantText === UI_SEED_CONTRACTOR);
    expect(contractor?.researchPending).toBe(true);
    expect(contractor?.suggestedCategoryId).toBeNull();
    expect(contractor?.suggestedReason).toBe('');
    const group = listed.groups.find((entry) => entry.merchantText === UI_SEED_CONTRACTOR);
    expect(group?.suggestedCategoryId).toBeNull();
    expect(group?.suggestedCategoryLabel).toBeNull();
    expect(group?.items.every((row) => row.researchPending)).toBe(true);
  });

  it('looks up an opaque PayNow payee on demand when the cache is empty', async () => {
    const merchant = 'FAST PAYMENT via PayNow-UEN to ABOVE ALL ENTERP OTHR-OTHR';
    insertTx(db, 'tx-paynow', merchant, -1850);
    insertReview(db, 'tx-paynow', HAWKER, 0.51);
    const acra: AcraLookup = {
      lookupByUen: async () => null,
      lookupByName: async (name) => {
        expect(name).toBe('ABOVE ALL ENTERP');
        return {
          uen: '202615975E',
          entityName: 'ABOVE ALL ENTERPRISE PTE. LTD.',
          entityStatus: 'Live Company',
          ssicCode: '56122',
          ssicDescription: 'Food courts, coffee shops and eating houses',
          registeredAddress: '206 Serangoon Central #04-158 S(550206)',
          incorporationDate: '2026-04-10',
          sourceUrl: 'https://opengovsg.com/corporate/202615975E',
        };
      },
    };
    const live = new ReviewService(
      db,
      new CategoriserService(db, { schema }),
      new MerchantEnrichmentService(db, new Set(['acra']), acra, { lookup: async () => null }, 0)
    );
    expect(live.list().items[0]?.enrichmentLine).toBeNull();
    expect(live.list().items[0]?.researchPending).toBe(true);
    expect(live.list().items[0]?.suggestedCategoryId).toBeNull();
    const enriched = await live.enrich('cat-tx-paynow');
    expect(enriched.enrichmentLine).toContain('ABOVE ALL ENTERPRISE PTE. LTD.');
    expect(enriched.entity?.registeredName).toBe('ABOVE ALL ENTERPRISE PTE. LTD.');
    expect(enriched.entity?.address).toBe('206 Serangoon Central #04-158 S(550206)');
    expect(enriched.entity?.registeredLabel).toBe('registered Apr 2026');
    expect(enriched.entity?.sourceUrl).toBe('https://opengovsg.com/corporate/202615975E');
    expect(enriched.suggestedPayee).toBe('Above All Enterprise');
    expect(enriched.researchPending).toBe(false);
    expect(enriched.suggestedReason).toMatch(/coffee shop/i);
    expect(enriched.suggestedCategoryId).toBe(HAWKER);
  });

  it('falls back to the heuristic with no research match when ACRA finds nothing', async () => {
    const merchant = 'FAST PAYMENT via PayNow to LIM AH HOCK OTHR-OTHR';
    insertTx(db, 'tx-con', merchant, -350000);
    insertReview(db, 'tx-con', 'exp.housing.utilities', 0.41);
    const acra: AcraLookup = {
      lookupByUen: async () => null,
      lookupByName: async () => null,
    };
    const live = new ReviewService(
      db,
      new CategoriserService(db, { schema }),
      new MerchantEnrichmentService(db, new Set(['acra']), acra, { lookup: async () => null }, 0)
    );
    expect(live.list().items[0]?.researchPending).toBe(true);
    expect(live.list().items[0]?.suggestedCategoryId).toBeNull();
    expect(live.list().items[0]?.suggestedReason).toBe('');
    const enriched = await live.enrich('cat-tx-con');
    expect(enriched.researchPending).toBe(false);
    expect(enriched.entity).toBeNull();
    expect(enriched.suggestedCategoryId).toBe('exp.housing.utilities');
    expect(enriched.suggestedReason).toBe(NO_RESEARCH_MATCH);
    expect(enriched.confidence).toBe(0.41);
  });

  it('surfaces triangulated evidence on the review item', () => {
    db.prepare(
      "INSERT INTO household_members (id, name, email, created_at) VALUES ('mem-alex', 'Alex', 'a@example.com', ?)"
    ).run(Date.now());
    insertTx(db, 'tx-jewel', 'JEWEL CHANGI', -19900);
    insertReview(db, 'tx-jewel', HAWKER, 0.54);
    db.prepare(`
      INSERT INTO context_links (
        id, transaction_id, kind, source_id, confidence, snippet, proposed_split, status, created_at
      ) VALUES ('lnk-1', 'tx-jewel', 'place', 'vis-1', 0.8, 'at Jewel Changi 2:10–2:40pm', NULL, 'proposed', ?)
    `).run(Date.now());
    db.prepare(`
      INSERT INTO spent_attributions (transaction_id, member_id, source, status)
      VALUES ('tx-jewel', 'mem-alex', 'order', 'proposed')
    `).run();
    const item = service.list().items.find((row) => row.transactionId === 'tx-jewel');
    expect(item?.contextSnippets.map((row) => row.snippet)).toEqual(['at Jewel Changi 2:10–2:40pm']);
    expect(item?.spentBy).toBe('Alex');
  });

  it('skips without changing category and undoes the skip', () => {
    insertTx(db, 'tx-k1', 'Kopi Corner', -480);
    insertReview(db, 'tx-k1', HAWKER, 0.62);
    const skipped = service.resolve('cat-tx-k1', { skip: true });
    expect(db.prepare('SELECT category FROM transactions WHERE id = ?').get('tx-k1')).toEqual({ category: null });
    expect(service.list().count).toBe(0);
    service.undo(skipped.undoId);
    expect(service.list().count).toBe(1);
  });

  it('tags an opaque PayNow payee with a project and writes memory', () => {
    const merchant = 'FAST PAYMENT via PayNow to LIM AH HOCK OTHR-OTHR';
    insertTx(db, 'tx-con', merchant, -350000);
    insertReview(db, 'tx-con', 'exp.housing.utilities', 0.41);
    const item = service.list().items.find((row) => row.transactionId === 'tx-con');
    expect(item?.opaque).toBe(true);
    expect(item?.showPayeeNotes).toBe(true);
    expect(item?.showCapitalTransfer).toBe(true);
    expect(item?.payeeName).toBe('LIM AH HOCK');

    const saved = service.savePayeeNote('cat-tx-con', {
      payeeLabel: 'Renovation contractor',
      project: 'Home renovation',
    });
    expect(saved.undoId).toBeTruthy();
    const note = db.prepare(
      'SELECT payee_label, project, category_id FROM payee_notes'
    ).get() as { payee_label: string; project: string; category_id: string };
    expect(note).toEqual({
      payee_label: 'Renovation contractor',
      project: 'Home renovation',
      category_id: 'exp.housing.utilities',
    });
    expect(db.prepare('SELECT category FROM transactions WHERE id = ?').get('tx-con')).toEqual({
      category: 'exp.housing.utilities',
    });
    expect(db.prepare('SELECT COUNT(*) as c FROM merchant_memory').get()).toEqual({ c: 1 });
    expect(service.list().count).toBe(0);

    service.undo(saved.undoId);
    expect(service.list().count).toBe(1);
    expect(db.prepare('SELECT COUNT(*) as c FROM payee_notes').get()).toEqual({ c: 0 });
  });

  it('marks a cashier\'s order as a one-off capital transfer without memory', () => {
    const merchant = "CASHIER'S ORDER TO ABC HOUSING PTE LTD";
    insertTx(db, 'tx-co', merchant, -50000000);
    insertReview(db, 'tx-co', 'xfer.own', 0.18);
    const item = service.list().items.find((row) => row.transactionId === 'tx-co');
    expect(item?.opaque).toBe(true);
    expect(item?.showCapitalTransfer).toBe(true);

    service.savePayeeNote('cat-tx-co', { capitalTransfer: true });
    expect(db.prepare('SELECT category FROM transactions WHERE id = ?').get('tx-co')).toEqual({
      category: CAPITAL_TRANSFER_CATEGORY,
    });
    expect(db.prepare('SELECT COUNT(*) as c FROM payee_notes').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) as c FROM merchant_memory').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) as c FROM merchant_rules').get()).toEqual({ c: 0 });
  });

  it('hides payee notes on named shops', () => {
    insertTx(db, 'tx-k1', 'Kopi Corner', -480);
    insertReview(db, 'tx-k1', HAWKER, 0.62);
    const item = service.list().items.find((row) => row.transactionId === 'tx-k1');
    expect(item?.opaque).toBe(false);
    expect(item?.showPayeeNotes).toBe(false);
    expect(item?.showCapitalTransfer).toBe(false);
  });
});
