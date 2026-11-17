import { parsePayeeAndUen } from './payee-parse.js';

const LEGAL_SUFFIX = /\b(PTE\.?|LTD\.?|LIMITED|PRIVATE|LLP|LLC|INC\.?)\b/gi;
const SMALL_WORDS = new Set(['and', 'or', 'of', 'the', 'a', 'an', 'at', 'to', 'via']);

export function titleCaseName(raw: string): string {
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  return cleaned
    .toLowerCase()
    .split(' ')
    .map((word, index) => {
      if (/^\d/.test(word)) return word.toUpperCase();
      if (index > 0 && SMALL_WORDS.has(word)) return word;
      if (/^(pte|ltd|llp|llc)$/i.test(word)) {
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      }
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

export function friendlyRegisteredName(registeredName: string | null | undefined): string | null {
  if (!registeredName) return null;
  const stripped = registeredName.replace(LEGAL_SUFFIX, ' ').replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  const named = titleCaseName(stripped || registeredName);
  return named || null;
}

export function cleanedPayeeDisplay(merchantText: string): string {
  const parsed = parsePayeeAndUen(merchantText);
  const source = parsed.payeeName || merchantText;
  const stripped = source
    .replace(/\b(PAYNOW|PAY[\s-]*NOW|FAST(?:\s+PAYMENT)?|GIRO|IBG|OTHR(?:-OTHR)?|OTHER(?:-OTHER)?|UEN|VIA|REF\.?\s*\w+)\b/gi, ' ')
    .replace(/\b\d{4,}\b/g, ' ')
    .replace(/[^A-Za-z0-9&/.\-\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return titleCaseName(stripped || source || merchantText);
}

export function displayMerchantName(options: {
  savedPayee?: string | null;
  registeredName?: string | null;
  merchantText: string;
}): string {
  const saved = options.savedPayee?.trim();
  if (saved) return saved;
  return friendlyRegisteredName(options.registeredName) ?? cleanedPayeeDisplay(options.merchantText);
}

export function formatSgdAmount(cents: number): string {
  return `S$${(Math.abs(cents) / 100).toFixed(2)}`;
}

export function opengovsgCorporateUrl(uen: string): string {
  return `https://opengovsg.com/corporate/${uen.trim().toUpperCase()}`;
}
