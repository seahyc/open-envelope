import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/server/db/migrations.js';
import { ConnectionsService } from '../../src/server/services/context/connections-service.js';
import { CalendarPollService } from '../../src/server/services/context/calendar-poll.js';
import { LocationIngestService } from '../../src/server/services/context/location-ingest.js';
import { OrdersIngestService } from '../../src/server/services/context/orders-ingest.js';
import { DEFAULT_HOUSEHOLD_ID, runWithHousehold } from '../../src/server/lib/tenancy.js';

describe('Connections household isolation', () => {
  let db: Database.Database;
  let connections: ConnectionsService;
  const previousDomain = process.env.EMAIL_INGEST_DOMAIN;
  const previousOrders = process.env.CONTEXT_ORDERS;

  beforeEach(() => {
    process.env.EMAIL_INGEST_DOMAIN = 'ingest.example.test';
    process.env.CONTEXT_ORDERS = '1';
    db = new Database(':memory:');
    runMigrations(db, { quiet: true });
    const now = Date.now();
    db.prepare(
      "INSERT INTO household_members (id, household_id, name, email, created_at) VALUES ('m-1', ?, 'Alex', 'alex@example.test', ?)"
    ).run(DEFAULT_HOUSEHOLD_ID, now);
    db.prepare(
      "INSERT INTO households (id, name, currency, onboarding_step, created_at, updated_at) VALUES ('hh-2', 'Other', 'USD', 'complete', ?, ?)"
    ).run(now, now);
    db.prepare(
      "INSERT INTO household_members (id, household_id, name, email, created_at) VALUES ('m-2', 'hh-2', 'Alex', 'other@example.test', ?)"
    ).run(now);
    connections = new ConnectionsService(
      db,
      new CalendarPollService(db),
      new LocationIngestService(db),
    );
  });

  afterEach(() => {
    if (previousDomain === undefined) delete process.env.EMAIL_INGEST_DOMAIN;
    else process.env.EMAIL_INGEST_DOMAIN = previousDomain;
    if (previousOrders === undefined) delete process.env.CONTEXT_ORDERS;
    else process.env.CONTEXT_ORDERS = previousOrders;
    db.close();
  });

  it('mints mailboxes and orders onto the current household only', () => {
    const snap1 = connections.snapshot('alex@example.test', 'http://localhost');
    expect(snap1?.member.id).toBe('m-1');
    const box1 = connections.enableMailbox(snap1!.member);
    expect(connections.mailboxForRecipient(box1.address)?.householdId).toBe(DEFAULT_HOUSEHOLD_ID);

    const box2 = runWithHousehold('hh-2', () => {
      const snap2 = connections.snapshot('other@example.test', 'http://localhost');
      expect(snap2?.member.id).toBe('m-2');
      return connections.enableMailbox(snap2!.member);
    });
    expect(connections.mailboxForRecipient(box2.address)?.householdId).toBe('hh-2');
    expect(box1.localPart).not.toBe(box2.localPart);

    const orders = new OrdersIngestService(db);
    runWithHousehold('hh-2', () => {
      orders.ingest('m-2', [{
        merchant: 'lazada',
        order_id: 'LZ-100',
        total_cents: 1200,
        currency: 'SGD',
        items: [{ name: 'mug', qty: 1, line_cents: 1200 }],
      }]);
    });
    expect(db.prepare("SELECT household_id FROM orders WHERE order_ref = 'LZ-100'").get()).toEqual({ household_id: 'hh-2' });
    expect(db.prepare("SELECT COUNT(*) as n FROM orders WHERE household_id = ?").get(DEFAULT_HOUSEHOLD_ID)).toEqual({ n: 0 });
  });
});
