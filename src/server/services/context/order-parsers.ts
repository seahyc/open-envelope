import type Database from 'better-sqlite3';
import { contextFlag } from '../../lib/context-flags.js';
import { extractPdfText, isPdfBuffer } from '../../lib/pdf-text-extractor.js';
import { OrdersIngestService } from './orders-ingest.js';

export type OrderMerchant =
  | 'lazada'
  | 'grab'
  | 'gojek'
  | 'ryde'
  | 'shopify'
  | 'google_play'
  | 'shopee'
  | 'amazon_sg'
  | 'fairprice';

export interface ParsedOrderItem {
  name: string;
  qty: number;
  unitCents: number | null;
  lineCents: number | null;
}

export interface ParsedOrder {
  merchant: OrderMerchant;
  orderRef: string;
  totalCents: number | null;
  currency: string;
  orderedAt: number | null;
  items: ParsedOrderItem[];
}

export async function parseReceiptEmail(raw: string): Promise<ParsedOrder | null> {
  const extra = await pdfTextFromMime(raw);
  return parseReceiptText(raw, extra);
}

export function parseReceiptText(raw: string, extraText = ''): ParsedOrder | null {
  const headerDate = dateFromEmail(raw);
  const text = `${stripHtml(raw)}\n${extraText}`;
  const parsed = parseLazada(text)
    || parseGrab(text)
    || parseGojek(text)
    || parseRyde(text)
    || parseShopify(raw, text)
    || parseGooglePlay(raw, text)
    || parseShopee(text)
    || parseAmazonSg(text)
    || parseFairPrice(text);
  if (!parsed) return null;
  if (parsed.orderedAt == null) parsed.orderedAt = headerDate;
  return parsed;
}

export class OrderParseService {
  constructor(private db: Database.Database, private now: () => number = () => Date.now()) {}

  async ingestEmail(raw: string, options: { memberId?: string | null; sourceHash?: string | null } = {}): Promise<string | null> {
    if (!contextFlag('orders')) return null;
    const parsed = await parseReceiptEmail(raw);
    if (!parsed) return null;
    const ingest = new OrdersIngestService(this.db, this.now);
    const result = ingest.ingest(
      options.memberId ?? '',
      [{
        merchant: parsed.merchant,
        order_id: parsed.orderRef,
        placed_at: parsed.orderedAt,
        currency: parsed.currency,
        total_cents: parsed.totalCents,
        items: parsed.items.map((item) => ({
          name: item.name,
          qty: item.qty,
          unit_cents: item.unitCents,
          line_cents: item.lineCents,
        })),
      }],
      'email',
      { sourceHash: options.sourceHash ?? null },
    );
    return result.ids[0] ?? null;
  }
}

export async function pdfTextFromMime(raw: string): Promise<string> {
  const blocks = raw.split(/\n(?=Content-Type:)/i);
  const texts: string[] = [];
  for (const block of blocks) {
    if (!/application\/pdf/i.test(block.split('\n')[0] || '') && !/Content-Type:\s*application\/pdf/i.test(block)) {
      continue;
    }
    if (!/Content-Transfer-Encoding:\s*base64/i.test(block)) continue;
    const headerEnd = block.search(/\r?\n\r?\n/);
    if (headerEnd < 0) continue;
    const payload = block.slice(headerEnd).split(/\n--/)[0] ?? '';
    const data = payload.replace(/[^A-Za-z0-9+/=]/g, '');
    try {
      const buf = Buffer.from(data, 'base64');
      if (!isPdfBuffer(buf)) continue;
      const text = await extractPdfText(buf);
      if (text.trim()) texts.push(text);
    } catch {
      /* ignore a bad attachment */
    }
  }
  return texts.join('\n');
}

function parseLazada(text: string): ParsedOrder | null {
  if (!/lazada/i.test(text) && !/receipt for order/i.test(text)) return null;
  if (!/lazada/i.test(text)) return null;
  const orderRef = matchOne(text, /(?:order\s*(?:no\.?|number|#)|receipt for order)\s*[:.]?\s*([A-Z0-9-]{8,})/i);
  if (!orderRef) return null;
  return {
    merchant: 'lazada',
    orderRef,
    totalCents: moneyCents(text),
    currency: 'SGD',
    orderedAt: dateFromEmail(text),
    items: parseItemLines(text),
  };
}

function parseGrab(text: string): ParsedOrder | null {
  if (!/\bgrab(?:food)?\b/i.test(text)) return null;
  const orderRef = matchOne(text, /booking\s*id\s*[:.]?\s*([A-Z0-9-]{6,})/i)
    || matchOne(text, /order\s*(?:id|no\.?|#)\s*[:.]?\s*([A-Z0-9-]{6,})/i);
  if (!orderRef) return null;
  const kind = /grabfood|grab food/i.test(text) ? 'GrabFood' : 'Grab ride';
  const foodItems = parseItemLines(text);
  const fareItems = parseFareBreakdown(text);
  const items = foodItems.length > 0 ? [...foodItems, ...fareItems] : fareItems;
  if (items.length === 0) {
    items.push({ name: kind, qty: 1, unitCents: moneyCents(text), lineCents: moneyCents(text) });
  }
  return {
    merchant: 'grab',
    orderRef,
    totalCents: moneyCents(text),
    currency: 'SGD',
    orderedAt: dateFromEmail(text),
    items,
  };
}

function parseGojek(text: string): ParsedOrder | null {
  if (!/gojek/i.test(text)) return null;
  const orderRef = matchOne(text, /(?:invoice|order)\s*(?:id|no\.?|#)\s*[:.]?\s*([A-Z0-9-]{6,})/i);
  if (!orderRef) return null;
  const items = parseFareBreakdown(text);
  if (items.length === 0) {
    items.push({ name: 'Gojek trip', qty: 1, unitCents: moneyCents(text), lineCents: moneyCents(text) });
  }
  return {
    merchant: 'gojek',
    orderRef,
    totalCents: moneyCents(text),
    currency: detectCurrency(text),
    orderedAt: dateFromEmail(text),
    items,
  };
}

function parseRyde(text: string): ParsedOrder | null {
  if (!/\bryde\b/i.test(text)) return null;
  const orderRef = matchOne(text, /(?:booking|trip)\s*id\s*[:.]?\s*([A-Z0-9-]{6,})/i)
    || matchOne(text, /order\s*(?:id|no\.?|#)\s*[:.]?\s*([A-Z0-9-]{6,})/i);
  if (!orderRef) return null;
  const items = parseFareBreakdown(text);
  if (items.length === 0) {
    items.push({ name: 'Ryde trip', qty: 1, unitCents: moneyCents(text), lineCents: moneyCents(text) });
  }
  return {
    merchant: 'ryde',
    orderRef,
    totalCents: moneyCents(text),
    currency: 'SGD',
    orderedAt: dateFromEmail(text),
    items,
  };
}

function parseShopify(raw: string, text: string): ParsedOrder | null {
  if (!/shopify/i.test(raw) && !/t\.shopifyemail\.com/i.test(raw)) return null;
  const orderRef = matchOne(text, /order\s*#\s*(\d{3,})/i)
    || matchOne(text, /order\s*(?:number|no\.?)\s*[:.]?\s*(\d{3,})/i);
  if (!orderRef) return null;
  return {
    merchant: 'shopify',
    orderRef,
    totalCents: moneyCents(text),
    currency: detectCurrency(text),
    orderedAt: dateFromEmail(text),
    items: parseItemLines(text),
  };
}

function parseGooglePlay(raw: string, text: string): ParsedOrder | null {
  if (!/google\s*play/i.test(text) && !/googleplay-noreply@google\.com/i.test(raw)) return null;
  const orderRef = matchOne(text, /(GPA\.[0-9]{4}-[0-9]{4}-[0-9]{4}-[0-9]{5})/i)
    || matchOne(text, /order\s*(?:number|no\.?|#)\s*[:.]?\s*([A-Z0-9.-]{8,})/i);
  if (!orderRef) return null;
  const itemName = matchOne(text, /(?:item|you bought|title)\s*[:.]?\s*(.+?)(?:\s+you paid|\s+S\$|$)/i)
    || 'Google Play item';
  const total = moneyCents(text);
  return {
    merchant: 'google_play',
    orderRef,
    totalCents: total,
    currency: detectCurrency(text),
    orderedAt: dateFromEmail(text),
    items: [{ name: itemName.trim(), qty: 1, unitCents: total, lineCents: total }],
  };
}

function parseShopee(text: string): ParsedOrder | null {
  if (!/shopee/i.test(text)) return null;
  const orderRef = matchOne(text, /order\s*(?:id|no\.?|#)\s*[:.]?\s*([A-Z0-9]{6,})/i);
  if (!orderRef) return null;
  return {
    merchant: 'shopee',
    orderRef,
    totalCents: moneyCents(text),
    currency: 'SGD',
    orderedAt: dateFromEmail(text),
    items: parseItemLines(text),
  };
}

function parseAmazonSg(text: string): ParsedOrder | null {
  if (!/amazon\.sg|amazon singapore/i.test(text)) return null;
  const orderRef = matchOne(text, /order\s*#\s*(\d{3}-\d{7}-\d{7})/i);
  if (!orderRef) return null;
  return {
    merchant: 'amazon_sg',
    orderRef,
    totalCents: moneyCents(text),
    currency: 'SGD',
    orderedAt: dateFromEmail(text),
    items: parseItemLines(text),
  };
}

function parseFairPrice(text: string): ParsedOrder | null {
  if (!/fairprice/i.test(text)) return null;
  const orderRef = matchOne(text, /order\s*(?:number|no\.?|#)\s*[:.]?\s*([A-Z0-9-]{6,})/i);
  if (!orderRef) return null;
  return {
    merchant: 'fairprice',
    orderRef,
    totalCents: moneyCents(text),
    currency: 'SGD',
    orderedAt: dateFromEmail(text),
    items: parseItemLines(text),
  };
}

function parseItemLines(text: string): ParsedOrderItem[] {
  const items: ParsedOrderItem[] = [];
  const seen = new Set<string>();
  const qtyFirst = /(\d+)\s*x\s+(.+?)\s+S\$\s*([0-9]+(?:\.[0-9]{2})?)/gi;
  let match: RegExpExecArray | null;
  while ((match = qtyFirst.exec(text))) {
    const qty = Number(match[1]);
    const lineCents = Math.round(Number(match[3]) * 100);
    const name = match[2]!.trim();
    const key = `${name}|${qty}|${lineCents}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      name,
      qty,
      unitCents: qty ? Math.round(lineCents / qty) : lineCents,
      lineCents,
    });
  }
  const layout = /^(.{3,80}?)\s+(\d+)\s+S\$\s*([0-9]+(?:\.[0-9]{2})?)\s*$/gim;
  while ((match = layout.exec(text))) {
    const name = match[1]!.trim();
    if (/^(item|qty|total|grand|order|subtotal)/i.test(name)) continue;
    const qty = Number(match[2]);
    const lineCents = Math.round(Number(match[3]) * 100);
    const key = `${name}|${qty}|${lineCents}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      name,
      qty,
      unitCents: qty ? Math.round(lineCents / qty) : lineCents,
      lineCents,
    });
  }
  return items;
}

function parseFareBreakdown(text: string): ParsedOrderItem[] {
  const items: ParsedOrderItem[] = [];
  const re = /(?<!total\s)(fare|booking fee|promo|platform fee|surcharge|toll|parking|delivery fee)\s*[:.]?\s*(-)?S\$\s*([0-9]+(?:\.[0-9]{2})?)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const sign = match[2] ? -1 : 1;
    const lineCents = sign * Math.round(Number(match[3]) * 100);
    items.push({
      name: match[1]!.replace(/\b\w/g, (ch) => ch.toUpperCase()),
      qty: 1,
      unitCents: lineCents,
      lineCents,
    });
  }
  return items;
}

function moneyCents(text: string): number | null {
  const match = text.match(/(?:order total|grand total|total fare|total|you paid|amount)\s*[:.]?\s*(?:S\$|SGD|Rp)?\s*([0-9]+(?:\.[0-9]{2})?)/i)
    || text.match(/S\$\s*([0-9]+(?:\.[0-9]{2})?)\s*$/m);
  if (!match) return null;
  return Math.round(Number(match[1]) * 100);
}

function detectCurrency(text: string): string {
  if (/\bRp\b|IDR/i.test(text) && !/S\$|SGD/i.test(text)) return 'IDR';
  return 'SGD';
}

function dateFromEmail(text: string): number | null {
  const match = text.match(/^Date:\s*(.+)$/im);
  if (!match) return null;
  const ts = Date.parse(match[1]!);
  return Number.isFinite(ts) ? ts : null;
}

function matchOne(text: string, re: RegExp): string | null {
  return text.match(re)?.[1]?.trim() || null;
}

function stripHtml(raw: string): string {
  return raw
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .replace(/\r/g, '\n');
}
