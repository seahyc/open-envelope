import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import PDFDocument from 'pdfkit';
import { runMigrations } from '../../src/server/db/migrations.js';
import { OrderParseService, parseReceiptEmail } from '../../src/server/services/context/order-parsers.js';

const dir = join(process.cwd(), 'fixtures/context');

function eml(name: string): string {
  return readFileSync(join(dir, name), 'utf8');
}

function buildPdf(lines: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk) => chunks.push(chunk as Buffer));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.font('Courier').fontSize(10);
    for (const line of lines) {
      doc.text(line);
    }
    doc.end();
  });
}

async function lazadaPdfEmail(): Promise<string> {
  const pdf = await buildPdf([
    'Lazada receipt',
    'Receipt for order LZ-PDF-001',
    '1 x USB-C cable S$ 12.90',
    '1 x Phone case S$ 8.10',
    'Order total: S$ 21.00',
  ]);
  const b64 = pdf.toString('base64').match(/.{1,76}/g)!.join('\n');
  return [
    'From: order@lazada.sg',
    'To: alex@example.test',
    'Subject: Receipt for order LZ-PDF-001',
    'Date: Wed, 14 Oct 2026 10:00:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="oe-bound"',
    '',
    '--oe-bound',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    'Receipt for order from Lazada',
    'Order No: LZ-PDF-001',
    'Order total: S$ 21.00',
    '',
    '--oe-bound',
    'Content-Type: application/pdf',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="receipt.pdf"',
    '',
    b64,
    '',
    '--oe-bound--',
    '',
  ].join('\n');
}

describe('receipt email parsers', () => {
  it('parses Lazada line items', async () => {
    const parsed = await parseReceiptEmail(eml('lazada-receipt.eml'));
    expect(parsed).toMatchObject({
      merchant: 'lazada',
      orderRef: 'LZ-20261014-001',
      totalCents: 2100,
    });
    expect(parsed?.items).toEqual([
      { name: 'USB-C cable', qty: 1, unitCents: 1290, lineCents: 1290 },
      { name: 'Phone case', qty: 1, unitCents: 810, lineCents: 810 },
    ]);
    expect(parsed?.orderedAt).toBe(Date.parse('Wed, 14 Oct 2026 10:00:00 +0000'));
  });

  it('parses Lazada PDF attachment line items', async () => {
    const parsed = await parseReceiptEmail(await lazadaPdfEmail());
    expect(parsed).toMatchObject({
      merchant: 'lazada',
      orderRef: 'LZ-PDF-001',
      totalCents: 2100,
    });
    expect(parsed?.items).toEqual([
      { name: 'USB-C cable', qty: 1, unitCents: 1290, lineCents: 1290 },
      { name: 'Phone case', qty: 1, unitCents: 810, lineCents: 810 },
    ]);
  });

  it('parses Grab ride fare breakdown', async () => {
    const parsed = await parseReceiptEmail(eml('grab-ride-receipt.eml'));
    expect(parsed).toMatchObject({
      merchant: 'grab',
      orderRef: 'A-8899001',
      totalCents: 820,
    });
    expect(parsed?.items).toEqual([
      { name: 'Fare', qty: 1, unitCents: 850, lineCents: 850 },
      { name: 'Booking Fee', qty: 1, unitCents: 70, lineCents: 70 },
      { name: 'Promo', qty: 1, unitCents: -100, lineCents: -100 },
    ]);
  });

  it('parses GrabFood booking id, items, and fare', async () => {
    const parsed = await parseReceiptEmail(eml('grab-food-receipt.eml'));
    expect(parsed).toMatchObject({
      merchant: 'grab',
      orderRef: 'GF-4400123',
      totalCents: 1030,
    });
    expect(parsed?.items).toEqual([
      { name: 'Nasi lemak', qty: 1, unitCents: 650, lineCents: 650 },
      { name: 'Teh peng', qty: 1, unitCents: 180, lineCents: 180 },
      { name: 'Fare', qty: 1, unitCents: 830, lineCents: 830 },
      { name: 'Delivery Fee', qty: 1, unitCents: 200, lineCents: 200 },
    ]);
  });

  it('parses Gojek invoice', async () => {
    const parsed = await parseReceiptEmail(eml('gojek-invoice.eml'));
    expect(parsed).toMatchObject({
      merchant: 'gojek',
      orderRef: 'GK-998877',
      totalCents: 1000,
    });
    expect(parsed?.items).toEqual([
      { name: 'Fare', qty: 1, unitCents: 940, lineCents: 940 },
      { name: 'Platform Fee', qty: 1, unitCents: 60, lineCents: 60 },
    ]);
  });

  it('parses Ryde trip receipt', async () => {
    const parsed = await parseReceiptEmail(eml('ryde-receipt.eml'));
    expect(parsed).toMatchObject({
      merchant: 'ryde',
      orderRef: 'RYDE778812',
      totalCents: 1230,
    });
    expect(parsed?.items).toEqual([
      { name: 'Ryde trip', qty: 1, unitCents: 1230, lineCents: 1230 },
    ]);
  });

  it('parses Shopify store receipts from t.shopifyemail.com', async () => {
    const parsed = await parseReceiptEmail(eml('shopify-receipt.eml'));
    expect(parsed).toMatchObject({
      merchant: 'shopify',
      orderRef: '1001',
      totalCents: 3000,
    });
    expect(parsed?.items).toEqual([
      { name: 'Seed packet', qty: 1, unitCents: 1200, lineCents: 1200 },
      { name: 'Clay pot', qty: 2, unitCents: 900, lineCents: 1800 },
    ]);
  });

  it('parses Google Play receipts', async () => {
    const parsed = await parseReceiptEmail(eml('google-play-receipt.eml'));
    expect(parsed).toMatchObject({
      merchant: 'google_play',
      orderRef: 'GPA.1234-5678-9012-34567',
      totalCents: 498,
    });
    expect(parsed?.items[0]).toMatchObject({ name: 'Pixel puzzles', qty: 1, lineCents: 498 });
  });

  it('still parses Shopee, Amazon SG, and FairPrice fixtures as later merchants', async () => {
    expect(await parseReceiptEmail(eml('shopee-receipt.eml'))).toMatchObject({
      merchant: 'shopee',
      orderRef: '220101',
      totalCents: 19900,
    });
    expect(await parseReceiptEmail(eml('amazon-sg-receipt.eml'))).toMatchObject({
      merchant: 'amazon_sg',
      orderRef: '123-1234567-1234567',
      totalCents: 1450,
    });
    expect(await parseReceiptEmail(eml('fairprice-receipt.eml'))).toMatchObject({
      merchant: 'fairprice',
      orderRef: 'FP-998877',
      totalCents: 1200,
    });
  });

  it('does not parse a bank alert as an order', async () => {
    expect(await parseReceiptEmail('Your DBS account was debited SGD 12.00 at STARBUCKS')).toBeNull();
  });
});

describe('OrderParseService', () => {
  let db: Database.Database;
  const previous = process.env.CONTEXT_ORDERS;

  beforeEach(() => {
    process.env.CONTEXT_ORDERS = '1';
    db = new Database(':memory:');
    runMigrations(db, { quiet: true });
    db.prepare(
      "INSERT INTO household_members (id, name, email, created_at) VALUES ('mem-alex', 'Alex', 'a@example.com', ?)"
    ).run(Date.now());
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.CONTEXT_ORDERS;
    else process.env.CONTEXT_ORDERS = previous;
    db.close();
  });

  it('writes orders + items when the flag is on and no-ops when off', async () => {
    const service = new OrderParseService(db);
    const id = await service.ingestEmail(eml('shopee-receipt.eml'), { memberId: 'mem-alex' });
    expect(id).toBeTruthy();
    expect(db.prepare('SELECT COUNT(*) as n FROM orders').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) as n FROM order_items').get()).toEqual({ n: 2 });
    process.env.CONTEXT_ORDERS = '';
    expect(await service.ingestEmail(eml('lazada-receipt.eml'))).toBeNull();
    expect(db.prepare('SELECT COUNT(*) as n FROM orders').get()).toEqual({ n: 1 });
  });
});
