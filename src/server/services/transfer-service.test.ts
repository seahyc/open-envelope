import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TransferService } from './transfer-service';
import { initDatabase, closeDatabase } from '../db/database';
import type Database from 'better-sqlite3';
import crypto from 'crypto';

function insertTx(
  db: Database.Database,
  accountId: string,
  amountCents: number,
  merchant: string,
  timestamp: number,
  observationIds: string[] = []
): string {
  const id = crypto.randomBytes(8).toString('hex');
  db.prepare(`
    INSERT INTO transactions (
      id, account_id, amount_cents, currency, timestamp,
      merchant_text, state, observation_ids, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, accountId, amountCents, 'SGD', timestamp, merchant, 'posted',
    JSON.stringify(observationIds), timestamp, timestamp
  );
  return id;
}

function insertObservation(db: Database.Database, id: string, documentHash = 'legacy-doc'): void {
  const existing = db.prepare('SELECT hash FROM raw_documents WHERE hash = ?').get(documentHash) as
    | { hash: string }
    | undefined;
  if (!existing) {
    db.prepare(`
      INSERT INTO raw_documents (hash, filename, mime_type, uploaded_at, size_bytes)
      VALUES (?, ?, ?, ?, ?)
    `).run(documentHash, 'legacy.txt', 'text/plain', Date.now(), 10);
  }
  db.prepare(`
    INSERT INTO observations (
      id, document_hash, account_hint, amount_cents, currency, timestamp,
      merchant_text, kind, adapter_name, is_statement, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, documentHash, 'acct', 0, 'SGD', Date.now(), 'legacy', 'transfer', 'ocbc-360', 1, Date.now());
}

function insertLegacyPossibleTransfer(
  db: Database.Database,
  opts: { id: string; observationId?: string | null; detail: string }
): void {
  db.prepare(`
    INSERT INTO review_queue (id, observation_id, document_hash, reason, detail, created_at)
    VALUES (?, ?, ?, 'possible_transfer', ?, ?)
  `).run(opts.id, opts.observationId ?? null, 'legacy-doc', opts.detail, Date.now());
}

describe('TransferService', () => {
  let db: Database.Database;
  let service: TransferService;
  let account1Id: string;
  let account2Id: string;
  let cardAccountId: string;

  beforeEach(() => {
    db = initDatabase(':memory:');
    service = new TransferService(db);
    
    account1Id = crypto.randomBytes(8).toString('hex');
    account2Id = crypto.randomBytes(8).toString('hex');
    cardAccountId = crypto.randomBytes(8).toString('hex');
    
    db.prepare(`
      INSERT INTO accounts (id, name, aliases, account_group, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(account1Id, 'Checking', JSON.stringify(['1111']), 'budget', Date.now());
    
    db.prepare(`
      INSERT INTO accounts (id, name, aliases, account_group, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(account2Id, 'Savings', JSON.stringify(['2222']), 'budget', Date.now());

    db.prepare(`
      INSERT INTO accounts (id, name, aliases, account_group, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(cardAccountId, 'OCBC Card', JSON.stringify(['card-4411']), 'credit', Date.now());
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('should detect and link transfer pairs', () => {
    const now = Date.now();
    const tx1Id = crypto.randomBytes(8).toString('hex');
    const tx2Id = crypto.randomBytes(8).toString('hex');

    db.prepare(`
      INSERT INTO transactions (
        id, account_id, amount_cents, currency, timestamp,
        merchant_text, state, observation_ids, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tx1Id, account1Id, -50000, 'USD', now,
      'Transfer to Savings', 'posted', JSON.stringify(['obs1']),
      now, now
    );

    db.prepare(`
      INSERT INTO transactions (
        id, account_id, amount_cents, currency, timestamp,
        merchant_text, state, observation_ids, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tx2Id, account2Id, 50000, 'USD', now + 1000,
      'Transfer from Checking', 'posted', JSON.stringify(['obs2']),
      now, now
    );

    service.detectAndLinkTransfers();

    const tx1 = db.prepare('SELECT linked_transaction_id FROM transactions WHERE id = ?')
      .get(tx1Id) as { linked_transaction_id: string | null };
    const tx2 = db.prepare('SELECT linked_transaction_id FROM transactions WHERE id = ?')
      .get(tx2Id) as { linked_transaction_id: string | null };

    expect(tx1.linked_transaction_id).toBe(tx2Id);
    expect(tx2.linked_transaction_id).toBe(tx1Id);
  });

  it('should not link transactions from same account', () => {
    const now = Date.now();

    db.prepare(`
      INSERT INTO transactions (
        id, account_id, amount_cents, currency, timestamp,
        merchant_text, state, observation_ids, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomBytes(8).toString('hex'), account1Id, -50000, 'USD', now,
      'Transaction 1', 'posted', JSON.stringify(['obs1']), now, now
    );

    db.prepare(`
      INSERT INTO transactions (
        id, account_id, amount_cents, currency, timestamp,
        merchant_text, state, observation_ids, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomBytes(8).toString('hex'), account1Id, 50000, 'USD', now,
      'Transaction 2', 'posted', JSON.stringify(['obs2']), now, now
    );

    service.detectAndLinkTransfers();

    const linked = db.prepare('SELECT COUNT(*) as count FROM transactions WHERE linked_transaction_id IS NOT NULL')
      .get() as { count: number };

    expect(linked.count).toBe(0);
  });

  it('should not link opposite-amount purchases that are not transfer-like', () => {
    const now = Date.now();
    insertTx(db, account1Id, -50000, 'FAIRPRICE FINEST', now);
    insertTx(db, account2Id, 50000, 'SALARY CREDIT', now + 60 * 60 * 1000);

    const result = service.detectAndLinkTransfers();

    const linked = db.prepare('SELECT COUNT(*) as count FROM transactions WHERE linked_transaction_id IS NOT NULL')
      .get() as { count: number };

    expect(linked.count).toBe(0);
    expect(result.linkedPairs).toBe(0);
    expect(result.reviewFlagged).toBe(0);
  });

  it('auto-links an unambiguous card bill payment within a few days', () => {
    const now = Date.now();
    const bankId = insertTx(db, account1Id, -12345, 'CARD PAYMENT TO OCBC 90N', now);
    const cardId = insertTx(db, cardAccountId, 12345, 'PAYMENT RECEIVED', now + 3 * 24 * 60 * 60 * 1000);

    const result = service.detectAndLinkTransfers();
    expect(result.linkedPairs).toBe(1);
    expect(result.reviewFlagged).toBe(0);

    const bank = db.prepare('SELECT linked_transaction_id FROM transactions WHERE id = ?').get(bankId) as {
      linked_transaction_id: string | null;
    };
    const card = db.prepare('SELECT linked_transaction_id FROM transactions WHERE id = ?').get(cardId) as {
      linked_transaction_id: string | null;
    };
    expect(bank.linked_transaction_id).toBe(cardId);
    expect(card.linked_transaction_id).toBe(bankId);
  });

  it('does not auto-link a card bill pair more than five days apart', () => {
    const now = Date.now();
    insertTx(db, account1Id, -12345, 'CARD PAYMENT TO OCBC 90N', now);
    insertTx(db, cardAccountId, 12345, 'PAYMENT RECEIVED', now + 6 * 24 * 60 * 60 * 1000);

    const result = service.detectAndLinkTransfers();
    expect(result.linkedPairs).toBe(0);
    const linked = db.prepare('SELECT COUNT(*) as count FROM transactions WHERE linked_transaction_id IS NOT NULL')
      .get() as { count: number };
    expect(linked.count).toBe(0);
  });

  it('auto-links own-account FAST/PayNow between two known accounts', () => {
    const now = Date.now();
    const outId = insertTx(db, account1Id, -8800, 'FAST PAYMENT via PayNow to 501-888888-001', now);
    const inId = insertTx(db, account2Id, 8800, 'PayNow Transfer from 550-765432-008', now + 2 * 60 * 60 * 1000);

    const result = service.detectAndLinkTransfers();
    expect(result.linkedPairs).toBe(1);

    const out = db.prepare('SELECT linked_transaction_id FROM transactions WHERE id = ?').get(outId) as {
      linked_transaction_id: string | null;
    };
    expect(out.linked_transaction_id).toBe(inId);
  });

  it('leaves an ambiguous transfer-like triple in review', () => {
    const now = Date.now();
    const extraId = crypto.randomBytes(8).toString('hex');
    db.prepare(`
      INSERT INTO accounts (id, name, aliases, account_group, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(extraId, 'SRS', JSON.stringify(['srs']), 'tracking', Date.now());

    insertTx(db, account1Id, -25000, 'FAST PAYMENT to own account', now);
    insertTx(db, account2Id, 25000, 'FAST collection via PayNow', now);
    insertTx(db, extraId, 25000, 'PayNow Transfer in', now + 1000);

    const result = service.detectAndLinkTransfers();
    expect(result.linkedPairs).toBe(0);
    expect(result.reviewFlagged).toBeGreaterThanOrEqual(2);

    const linked = db.prepare('SELECT COUNT(*) as count FROM transactions WHERE linked_transaction_id IS NOT NULL')
      .get() as { count: number };
    expect(linked.count).toBe(0);

    const reviews = db.prepare(
      "SELECT COUNT(*) as count FROM review_queue WHERE reason = 'possible_transfer' AND resolved = 0"
    ).get() as { count: number };
    expect(reviews.count).toBeGreaterThanOrEqual(2);
  });

  it('should get transfer pairs', () => {
    const now = Date.now();
    const tx1Id = crypto.randomBytes(8).toString('hex');
    const tx2Id = crypto.randomBytes(8).toString('hex');

    db.prepare(`
      INSERT INTO transactions (
        id, account_id, amount_cents, currency, timestamp,
        merchant_text, state, observation_ids, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tx1Id, account1Id, -50000, 'USD', now,
      'Transfer to Savings', 'posted', JSON.stringify(['obs1']),
      now, now
    );

    db.prepare(`
      INSERT INTO transactions (
        id, account_id, amount_cents, currency, timestamp,
        merchant_text, state, observation_ids, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tx2Id, account2Id, 50000, 'USD', now,
      'Transfer from Checking', 'posted', JSON.stringify(['obs2']),
      now, now
    );

    service.detectAndLinkTransfers();

    const pairs = service.getTransferPairs();
    expect(pairs).toHaveLength(1);
    
    const amounts = [pairs[0]?.tx1.amountCents, pairs[0]?.tx2.amountCents].sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(amounts[0]).toBe(-50000);
    expect(amounts[1]).toBe(50000);
  });

  it('closes legacy possible_transfer reviews on now-linked transactions via observation ids', () => {
    const now = Date.now();
    insertObservation(db, 'obs-bank');
    insertObservation(db, 'obs-card');
    insertTx(db, account1Id, -12345, 'CARD PAYMENT TO OCBC 90N', now, ['obs-bank']);
    insertTx(db, cardAccountId, 12345, 'PAYMENT RECEIVED', now + 1000, ['obs-card']);
    insertLegacyPossibleTransfer(db, {
      id: 'aabbcc01',
      observationId: 'obs-bank',
      detail: 'Possible transfer pair: CARD PAYMENT TO OCBC 90N and PAYMENT RECEIVED (OCBC Card)',
    });
    insertLegacyPossibleTransfer(db, {
      id: 'aabbcc02',
      observationId: 'obs-card',
      detail: 'Possible transfer pair: PAYMENT RECEIVED and CARD PAYMENT TO OCBC 90N (Checking)',
    });

    const first = service.detectAndLinkTransfers();
    expect(first.linkedPairs).toBe(1);
    expect(first.reviewsResolved).toBeGreaterThanOrEqual(2);

    const open = db.prepare(
      "SELECT COUNT(*) as count FROM review_queue WHERE reason = 'possible_transfer' AND resolved = 0"
    ).get() as { count: number };
    expect(open.count).toBe(0);

    const legacy = db.prepare(
      "SELECT resolved FROM review_queue WHERE id IN ('aabbcc01', 'aabbcc02')"
    ).all() as Array<{ resolved: number }>;
    expect(legacy.every((row) => row.resolved === 1)).toBe(true);

    const second = service.detectAndLinkTransfers();
    expect(second.linkedPairs).toBe(0);
    expect(second.reviewsResolved).toBe(0);
    const stillOpen = db.prepare(
      "SELECT COUNT(*) as count FROM review_queue WHERE reason = 'possible_transfer' AND resolved = 0"
    ).get() as { count: number };
    expect(stillOpen.count).toBe(0);
  });

  it('closes legacy possible_transfer reviews that the new rules no longer flag', () => {
    const now = Date.now();
    insertObservation(db, 'obs-grocery');
    const groceryId = insertTx(db, account1Id, -50000, 'FAIRPRICE FINEST', now, ['obs-grocery']);
    insertTx(db, account2Id, 50000, 'SALARY CREDIT', now);
    insertLegacyPossibleTransfer(db, {
      id: 'stale-obs',
      observationId: 'obs-grocery',
      detail: 'Possible transfer pair: FAIRPRICE FINEST and SALARY CREDIT (Savings)',
    });
    insertLegacyPossibleTransfer(db, {
      id: 'stale-txid',
      detail: JSON.stringify({ txId: groceryId }),
    });
    insertLegacyPossibleTransfer(db, {
      id: 'stale-transactionId',
      detail: JSON.stringify({ transactionId: groceryId }),
    });
    insertLegacyPossibleTransfer(db, {
      id: `possible-transfer:${groceryId}`,
      detail: JSON.stringify({ txId: groceryId, mateIds: [] }),
    });

    const result = service.detectAndLinkTransfers();
    expect(result.linkedPairs).toBe(0);
    expect(result.reviewFlagged).toBe(0);
    expect(result.reviewsResolved).toBe(4);

    const open = db.prepare(
      "SELECT id FROM review_queue WHERE reason = 'possible_transfer' AND resolved = 0"
    ).all() as Array<{ id: string }>;
    expect(open).toHaveLength(0);

    const again = service.detectAndLinkTransfers();
    expect(again.reviewsResolved).toBe(0);
  });

  it('keeps an open possible_transfer review when the transaction is still flagged', () => {
    const now = Date.now();
    const extraId = crypto.randomBytes(8).toString('hex');
    db.prepare(`
      INSERT INTO accounts (id, name, aliases, account_group, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(extraId, 'SRS', JSON.stringify(['srs']), 'tracking', Date.now());

    insertObservation(db, 'obs-fast');
    insertTx(db, account1Id, -25000, 'FAST PAYMENT to own account', now, ['obs-fast']);
    insertTx(db, account2Id, 25000, 'FAST collection via PayNow', now);
    insertTx(db, extraId, 25000, 'PayNow Transfer in', now + 1000);
    insertLegacyPossibleTransfer(db, {
      id: 'still-flagged',
      observationId: 'obs-fast',
      detail: 'Possible transfer pair: FAST PAYMENT to own account and FAST collection via PayNow (Savings)',
    });

    const result = service.detectAndLinkTransfers();
    expect(result.linkedPairs).toBe(0);
    const legacy = db.prepare(
      "SELECT resolved FROM review_queue WHERE id = 'still-flagged'"
    ).get() as { resolved: number };
    expect(legacy.resolved).toBe(0);
    const open = db.prepare(
      "SELECT COUNT(*) as count FROM review_queue WHERE reason = 'possible_transfer' AND resolved = 0"
    ).get() as { count: number };
    expect(open.count).toBeGreaterThanOrEqual(1);
  });
});
