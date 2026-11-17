const LOCATION_TOKENS = new Set([
  'SINGAPORE', 'SG', 'SGP',
  'MALAYSIA', 'MY', 'MYS',
  'HONGKONG', 'HONG', 'KONG', 'HK', 'HKG',
  'USA', 'US',
  'UNITED', 'KINGDOM', 'UK', 'GB', 'GBR',
  'AUSTRALIA', 'AU', 'AUS',
  'INDONESIA', 'ID', 'IDN',
  'THAILAND', 'TH', 'THA',
  'PHILIPPINES', 'PH', 'PHL',
  'CHINA', 'CN', 'CHN',
  'JAPAN', 'JP', 'JPN',
  'KOREA', 'KR', 'KOR',
  'INDIA', 'IN', 'IND',
  'NEWZEALAND', 'NZ', 'NZL',
  'UAE', 'AE', 'ARE',
  'TAIWAN', 'TW', 'TWN',
  'VIETNAM', 'VN', 'VNM',
]);

const RAIL_TOKENS = new Set([
  'FAST', 'PAYMENT', 'PAYMENTS',
  'PAYNOW', 'PAY', 'NOW',
  'VIA', 'TO', 'FROM', 'UEN',
  'GIRO', 'IBG', 'TRANSFER', 'TRANSFERS',
  'FUND', 'FUNDS',
  'TT', 'FPS', 'INSTANT',
  'TELEGRAPHIC', 'REMITTANCE',
  'PAYNOWUEN',
]);

const RAIL_LINE = /(FAST\s+PAYMENT|PAYNOW|PAY[\s-]*NOW|\bGIRO\b|\bATM\b|CASHIER'?S?\s*ORDER)/i;

export function isNoiseToken(token: string): boolean {
  if (!token) return true;
  if (/^\d+$/.test(token)) return true;
  if (/^(X{2,}|\*+)\d{4}$/.test(token)) return true;
  return LOCATION_TOKENS.has(token) || RAIL_TOKENS.has(token);
}

export function extractRailPayee(raw: string): string | null {
  const upper = raw.toUpperCase();
  if (!RAIL_LINE.test(upper)) return null;
  const afterTo = upper.match(/\bTO\b\s+(.+)$/);
  if (afterTo?.[1]?.trim()) return afterTo[1];
  const afterFrom = upper.match(/\bFROM\b\s+(.+)$/);
  if (afterFrom?.[1]?.trim()) return afterFrom[1];
  return null;
}

export function normalizeMerchantKey(raw: string): string {
  const payee = extractRailPayee(raw);
  const source = payee ?? raw;
  const cleaned = source
    .toUpperCase()
    .replace(/^(GRAB\*|AMZN\s+MKTP\s+\w+\*|SP\s+\*|PAYPAL\s+\*)/i, (match) => match.replace(/[^A-Z0-9]/g, ' '))
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned
    .split(' ')
    .filter((token) => token.length > 0 && !isNoiseToken(token))
    .join(' ');
}

export function shortMerchantKey(normalized: string): string {
  const tokens = normalized.split(' ').filter((token) => token.length >= 3 && !isNoiseToken(token));
  return tokens[0] ?? '';
}

export function meaningfulTokens(normalized: string): string[] {
  return normalized.split(' ').filter((token) => token.length >= 3 && !isNoiseToken(token));
}

export function wordBoundaryMatch(haystack: string, key: string): boolean {
  if (!key) return false;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Z0-9])${escaped}([^A-Z0-9]|$)`, 'i').test(haystack);
}

export function amountBand(amountCents: number): string {
  const abs = Math.abs(amountCents);
  if (abs < 1000) return '0-10';
  if (abs < 5000) return '10-50';
  if (abs < 20000) return '50-200';
  if (abs < 100000) return '200-1000';
  return '1000+';
}

export function memoTokens(memo: string | null | undefined): string {
  return normalizeMerchantKey(memo ?? '');
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
