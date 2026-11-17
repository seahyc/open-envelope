import type { ObservationKind } from '../../../shared/types.js';
import { BANK_ALERT_HINTS, type BankAlertHint } from '../../config/bank-alert-hints.js';

export type AlertParseMethod = 'patterns' | 'patterns+hint';

export interface BankAlertExtraction {
  accountHint: string;
  amountCents: number | null;
  currency: string;
  fxAmountCents?: number;
  fxCurrency?: string;
  timestamp: number | null;
  merchantText: string;
  kind: ObservationKind;
  confidence: number;
  method: AlertParseMethod;
  hintId: string | null;
  complete: boolean;
  looksLikeAlert: boolean;
}

const MONTHS: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

const CURRENCY = 'SGD|USD|EUR|GBP|AUD|MYR|JPY|CNY|HKD|THB|INR|NZD|CHF|CAD';
const DEBIT_WORDS = /\b(charged|debited|debit|spent|paid|sent|purchase|purchased|used|withdrawn|deducted|payment made)\b/i;
const CREDIT_WORDS = /\b(refunded|refund|credited|received|reversed|cashback|payment received)\b/i;
const ALERT_WORDS = /\b(transaction alert|card transaction|transaction notification|card ending|account ending|paynow|paylah|nets|charged|debited|refunded|credited)\b/i;
const STATEMENT_WORDS = /opening balance|closing balance|statement period|statement of account|total withdrawals|total deposits/i;
const BALANCE_NEAR = /balance|available credit|credit limit|outstanding|remaining/i;

export function singaporeWallTimeToUtcMs(
  year: number,
  monthIndex: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  return Date.UTC(year, monthIndex, day, hour - 8, minute, second);
}

export function expandYear(year: number): number {
  if (year >= 100) return year;
  return year >= 70 ? 1900 + year : 2000 + year;
}

function extractHeader(text: string, name: string): string {
  const match = text.match(new RegExp(`^${name}:\\s*(.+)$`, 'im'));
  return match?.[1]?.trim() || '';
}

function extractBody(text: string): string {
  const parts = text.split(/\r?\n\r?\n/);
  if (parts.length < 2) return text;
  return parts.slice(1).join('\n\n');
}

function senderDomain(from: string): string {
  const match = from.match(/@([A-Za-z0-9.-]+)/);
  return (match?.[1] || '').toLowerCase().replace(/[>]$/, '');
}

export function hintForDomain(domain: string): BankAlertHint | null {
  const lowered = domain.toLowerCase();
  if (!lowered) return null;
  return BANK_ALERT_HINTS.find((hint) =>
    hint.domains.some((d) => lowered === d || lowered.endsWith(`.${d}`)),
  ) ?? null;
}

function isBalanceContext(text: string, index: number): boolean {
  return BALANCE_NEAR.test(text.slice(Math.max(0, index - 48), index + 48));
}

function parseMoneyToCents(raw: string): number | null {
  const cleaned = raw.replace(/,/g, '').trim();
  if (!cleaned) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

function parseClock(raw: string): { hour: number; minute: number; second: number } | null {
  const match = raw.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] ? Number(match[3]) : 0;
  const ampm = match[4]?.toLowerCase();
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return { hour, minute, second };
}

function findTimeNear(text: string, around?: number): { hour: number; minute: number; second: number } | null {
  const window = around == null
    ? text
    : text.slice(Math.max(0, around - 80), around + 80);
  const labeled = window.match(/\bTime:\s*(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]m)?)/i);
  if (labeled) return parseClock(labeled[1]!);
  const atTime = window.match(/\bat\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]m)?)/i);
  if (atTime) return parseClock(atTime[1]!);
  const any = window.match(/\b(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]m)?)\s*(?:sgt|sst)?/i);
  if (any) return parseClock(any[1]!);
  return null;
}

export function parseSingaporeDateTime(text: string): number | null {
  const candidates: Array<{ year: number; month: number; day: number; index: number }> = [];

  const monthName = /(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s](\d{2,4})/g;
  let match: RegExpExecArray | null;
  while ((match = monthName.exec(text)) !== null) {
    const month = MONTHS[match[2]!.toLowerCase()];
    if (month === undefined) continue;
    candidates.push({
      day: Number(match[1]),
      month,
      year: expandYear(Number(match[3])),
      index: match.index,
    });
  }

  const numeric = /(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})/g;
  while ((match = numeric.exec(text)) !== null) {
    candidates.push({
      day: Number(match[1]),
      month: Number(match[2]) - 1,
      year: expandYear(Number(match[3])),
      index: match.index,
    });
  }

  const iso = /(\d{4})-(\d{1,2})-(\d{1,2})/g;
  while ((match = iso.exec(text)) !== null) {
    candidates.push({
      year: Number(match[1]),
      month: Number(match[2]) - 1,
      day: Number(match[3]),
      index: match.index,
    });
  }

  for (const candidate of candidates) {
    if (candidate.month < 0 || candidate.month > 11 || candidate.day < 1 || candidate.day > 31) continue;
    const clock = findTimeNear(text, candidate.index) || findTimeNear(text);
    const hour = clock?.hour ?? 0;
    const minute = clock?.minute ?? 0;
    const second = clock?.second ?? 0;
    return singaporeWallTimeToUtcMs(candidate.year, candidate.month, candidate.day, hour, minute, second);
  }

  return parseRfc2822Date(extractHeader(text, 'Date'));
}

export function parseRfc2822Date(header: string): number | null {
  if (!header) return null;
  const parsed = new Date(header);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.getTime();
}

function extractAmount(text: string): { cents: number; currency: string; index: number } | null {
  const patterns = [
    new RegExp(`(?:Amount|Transaction Amount|Txn Amount):\\s*(?:(${CURRENCY})|S\\$|\\$)?\\s*([\\d,]+(?:\\.\\d{1,2})?)`, 'ig'),
    new RegExp(`\\b(${CURRENCY})\\s*([\\d,]+(?:\\.\\d{1,2})?)`, 'ig'),
    new RegExp(`([\\d,]+(?:\\.\\d{2}))\\s*(${CURRENCY})\\b`, 'ig'),
    /(?:S\$|\$)\s*([\d,]+(?:\.\d{2}))/ig,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (isBalanceContext(text, match.index)) continue;
      const groups = match.slice(1).filter((g) => g !== undefined);
      let currency = 'SGD';
      let amountRaw = '';
      for (const group of groups) {
        if (new RegExp(`^(?:${CURRENCY})$`, 'i').test(group)) currency = group.toUpperCase();
        else if (/[\d]/.test(group)) amountRaw = group;
      }
      if (match[0].includes('S$')) currency = 'SGD';
      else if (match[0].includes('$') && currency === 'SGD' && !/\bSGD\b/i.test(match[0])) {
        currency = /usd/i.test(text.slice(Math.max(0, match.index - 20), match.index + 20)) ? 'USD' : 'SGD';
      }
      const cents = parseMoneyToCents(amountRaw);
      if (cents == null || cents === 0) continue;
      return { cents, currency, index: match.index };
    }
  }
  return null;
}

function extractLast4(text: string): { hint: string; found: boolean } {
  if (/\bpaylah\b/i.test(text)) return { hint: 'paylah', found: true };
  const cardParen = text.match(/card\s*\(\s*-?(\d{4})\s*\)/i) || text.match(/\(\s*-(\d{4})\s*\)/);
  if (cardParen?.[1]) return { hint: `card-${cardParen[1]}`, found: true };
  const cardEnding = text.match(/card ending(?:\s+in)?\s+([A-Za-z0-9]{4})/i)
    || text.match(/ending(?:\s+in)?\s+([A-Za-z0-9]{4})/i);
  if (cardEnding?.[1] && /card/i.test(text)) return { hint: `card-${cardEnding[1]}`, found: true };
  const accountDbs = text.match(/account\s+(\d{3}-\d{5}-\d)/i);
  if (accountDbs?.[1]) return { hint: accountDbs[1].replace(/-/g, ''), found: true };
  const accountEnding = text.match(/account ending\s+(\d{4})/i);
  if (accountEnding?.[1]) return { hint: `acct-${accountEnding[1]}`, found: true };
  const ending = text.match(/ending(?:\s+in)?\s+(\d{4})/i);
  if (ending?.[1]) return { hint: `card-${ending[1]}`, found: true };
  const stars = text.match(/\*{4,}(\d{4})/);
  if (stars?.[1]) return { hint: `card-${stars[1]}`, found: true };
  return { hint: 'unknown', found: false };
}

function cleanMerchant(raw: string): string {
  return raw.replace(/\s+/g, ' ').replace(/[.,;:]+$/, '').trim();
}

function extractMerchant(text: string, body: string): string {
  const payNow = text.match(/PayNow to:\s*([^\n]+)/i) || text.match(/via PayNow to\s+([^.]+)/i);
  if (payNow?.[1]) return cleanMerchant(payNow[1]);

  const labeled = text.match(/Merchant:\s*([^\n]+)/i);
  if (labeled?.[1]) return cleanMerchant(labeled[1]);

  const atPlaces = [
    ...body.matchAll(/\b(?:at|used at|charged at)\s+(?!(\d{1,2}:\d{2}))([A-Z0-9][A-Z0-9 &'\-.#*]{1,60}?)(?=\s+on\b|\s+for\b|\s+to card\b|\s+to your\b|\.|$)/gi),
  ];
  for (const place of atPlaces) {
    const value = cleanMerchant(place[2] || '');
    if (!value || /^\d/.test(value) || /sgt|hotline|enquir/i.test(value)) continue;
    return value;
  }

  if (/\bpaylah\b/i.test(text)) {
    const person = body.match(/\b(?:from|to)\s+([A-Za-z][A-Za-z\s]{1,40}?)(?:\.|$|\s+on\b|\n)/i);
    if (person?.[1]) {
      const name = cleanMerchant(person[1]);
      const received = /received/i.test(text);
      return `PayLah ${received ? 'from' : 'to'} ${name}`;
    }
  }

  const fromTo = body.match(/\b(?:from|to)\s+([A-Z][A-Za-z0-9\s&'-]{1,40}?)(?:\.|$|\s+on\b)/);
  if (fromTo?.[1] && !/card|account|your/i.test(fromTo[1])) return cleanMerchant(fromTo[1]);
  return '';
}

function inferKind(text: string, credit: boolean): ObservationKind {
  if (credit && /refund/i.test(text)) return 'refund';
  if (/paynow/i.test(text) || (/\bsent\b/i.test(text) && !credit)) return 'transfer';
  if (credit) return 'deposit';
  return 'purchase';
}

function inferDirection(text: string, amountIndex: number): { credit: boolean; explicit: boolean } {
  const window = text.slice(Math.max(0, amountIndex - 60), amountIndex + 80);
  if (CREDIT_WORDS.test(window) || CREDIT_WORDS.test(text)) {
    if (DEBIT_WORDS.test(window) && !CREDIT_WORDS.test(window)) {
      return { credit: false, explicit: true };
    }
    if (CREDIT_WORDS.test(window) || (!DEBIT_WORDS.test(window) && CREDIT_WORDS.test(text))) {
      return { credit: true, explicit: true };
    }
  }
  if (DEBIT_WORDS.test(window) || DEBIT_WORDS.test(text)) return { credit: false, explicit: true };
  return { credit: false, explicit: false };
}

export function extractBankAlert(raw: string): BankAlertExtraction {
  const from = extractHeader(raw, 'From');
  const subject = extractHeader(raw, 'Subject');
  const body = extractBody(raw);
  const text = `${from}\n${subject}\n${body}`;
  const domain = senderDomain(from);
  const hint = hintForDomain(domain);
  const amount = extractAmount(text);
  const last4 = extractLast4(text);
  const merchantText = extractMerchant(text, body);
  const timestamp = parseSingaporeDateTime(`${subject}\n${body}`)
    ?? parseRfc2822Date(extractHeader(raw, 'Date'));
  const direction = inferDirection(text, amount?.index ?? 0);
  const amountCents = amount
    ? (direction.credit ? Math.abs(amount.cents) : -Math.abs(amount.cents))
    : null;
  const kind = inferKind(text, direction.credit);
  const looksLikeStatement = STATEMENT_WORDS.test(text);
  const looksLikeAlert = !looksLikeStatement && Boolean(
    ALERT_WORDS.test(text)
    || hint
    || (amount && last4.found)
    || (amount && merchantText),
  );

  let confidence = 0;
  if (amount) confidence += 0.4;
  if (amount?.currency) confidence += 0.1;
  if (merchantText) confidence += 0.2;
  if (last4.found) confidence += 0.15;
  if (timestamp != null && !extractHeader(raw, 'Date').includes(String(new Date(timestamp).getUTCFullYear()))) {
    confidence += 0.08;
  } else if (timestamp != null) {
    confidence += 0.05;
  }
  if (direction.explicit) confidence += 0.05;
  if (hint) confidence = Math.min(0.98, confidence + hint.boost);
  else confidence = Math.min(0.95, confidence);

  const complete = amountCents != null && Boolean(merchantText);
  return {
    accountHint: last4.hint,
    amountCents,
    currency: amount?.currency || 'SGD',
    timestamp,
    merchantText,
    kind,
    confidence,
    method: hint ? 'patterns+hint' : 'patterns',
    hintId: hint?.id ?? null,
    complete,
    looksLikeAlert,
  };
}

export function extractionToObservation(
  extracted: BankAlertExtraction,
  adapterName: string,
): {
  accountHint: string;
  amountCents: number;
  currency: string;
  timestamp: number;
  merchantText: string;
  kind: ObservationKind;
  adapterName: string;
  parseConfidence: number;
  parseMethod: string;
} | null {
  if (extracted.amountCents == null || !extracted.merchantText) return null;
  return {
    accountHint: extracted.accountHint,
    amountCents: extracted.amountCents,
    currency: extracted.currency,
    timestamp: extracted.timestamp ?? Date.now(),
    merchantText: extracted.merchantText,
    kind: extracted.kind,
    adapterName,
    parseConfidence: extracted.confidence,
    parseMethod: extracted.method,
  };
}
