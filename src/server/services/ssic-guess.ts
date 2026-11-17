import { findCategory, type CategoryKind, type CategorySchema } from '../categoriser/schema.js';
import { formatSgdAmount } from './display-name.js';
import { parsePayeeAndUen } from './payee-parse.js';

export interface SsicGuess {
  categoryId: string;
  confidence: number;
  rationale: string;
  probablyWas: string;
}

export interface DirectionGuardResult {
  categoryId: string | null;
  blocked: boolean;
  reason: string | null;
}

const SSIC_DESCRIPTIONS: Record<string, string> = {
  '56111': 'Restaurants',
  '56112': 'Cafes',
  '56121': 'Fast food outlets',
  '56122': 'Food courts, coffee shops and eating houses',
  '56140': 'Stalls selling cooked food and prepared drinks',
  '56201': 'Food caterers',
  '47111': 'Supermarkets and hypermarkets',
  '47112': 'Minimarts and convenience stores',
  '47220': 'Retail sale of beverages',
  '49212': 'Chartered bus services',
  '49220': 'Taxi and private hire',
  '41001': 'General contractors',
  '42101': 'Road construction',
};

interface SsicFamily {
  prefixes: string[];
  categoryId: string;
  noun: string;
  probablyWas: (amountCents: number) => string;
}

const FAMILIES: SsicFamily[] = [
  {
    prefixes: ['561', '562'],
    categoryId: 'exp.food.dining.hawker',
    noun: 'cafe operator',
    probablyWas: () => 'A meal or kopi at a coffee shop',
  },
  {
    prefixes: ['471', '472'],
    categoryId: 'exp.food.groceries',
    noun: 'grocer',
    probablyWas: () => 'Groceries from a supermarket',
  },
  {
    prefixes: ['4922', '4923'],
    categoryId: 'exp.transport.ride',
    noun: 'ride-hailing operator',
    probablyWas: () => 'A ride-hailing trip',
  },
  {
    prefixes: ['492', '493', '522'],
    categoryId: 'exp.transport.transit',
    noun: 'transport operator',
    probablyWas: () => 'A public-transport trip',
  },
  {
    prefixes: ['41', '42', '43'],
    categoryId: 'exp.housing.utilities',
    noun: 'contractor',
    probablyWas: (amountCents) => (
      Math.abs(amountCents) >= 100_000
        ? 'A renovation or construction payment'
        : 'A housing-related payment'
    ),
  },
  {
    prefixes: ['68'],
    categoryId: 'exp.housing.utilities',
    noun: 'property operator',
    probablyWas: () => 'A housing-related payment',
  },
];

export function ssicDescriptionFor(code: string | null | undefined, fallback?: string | null): string | null {
  const trimmed = fallback?.trim();
  if (trimmed && trimmed.toLowerCase() !== 'na' && trimmed !== '-') return trimmed;
  if (!code) return null;
  if (SSIC_DESCRIPTIONS[code]) return SSIC_DESCRIPTIONS[code];
  const family = familyFor(code);
  if (family?.noun) return family.noun;
  return null;
}

function familyFor(code: string): SsicFamily | null {
  const sorted = [...FAMILIES].sort((a, b) => b.prefixes[0]!.length - a.prefixes[0]!.length);
  for (const family of sorted) {
    if (family.prefixes.some((prefix) => code.startsWith(prefix))) return family;
  }
  return null;
}

export function guessFromSsic(options: {
  ssicCode?: string | null;
  ssicDescription?: string | null;
  amountCents: number;
  merchantText: string;
}): SsicGuess | null {
  const code = options.ssicCode?.trim() ?? '';
  if (!code) return null;
  if (options.amountCents > 0) return null;
  const family = familyFor(code);
  if (!family) return null;
  const desc = ssicDescriptionFor(code, options.ssicDescription);
  const rail = railNoun(options.merchantText);
  const noun = cafeNoun(code, desc) ?? family.noun;
  return {
    categoryId: family.categoryId,
    confidence: 0.56,
    rationale: `${formatSgdAmount(options.amountCents)} ${rail} to a ${noun}`,
    probablyWas: family.probablyWas(options.amountCents),
  };
}

function cafeNoun(code: string, desc: string | null): string | null {
  const haystack = `${code} ${desc ?? ''}`.toLowerCase();
  if (code.startsWith('561') || /cafe|coffee|food court|hawker|restaurant|eating house/.test(haystack)) {
    return 'cafe operator';
  }
  return null;
}

export function railNoun(merchantText: string): string {
  const text = merchantText.toUpperCase();
  if (/\bATM\b/.test(text)) return 'ATM';
  if (/CASHIER'?S?\s*ORDER/.test(text)) return "cashier's order";
  if (/PAYNOW|PAY[\s-]*NOW/.test(text)) return 'PayNow';
  if (/\bGIRO\b/.test(text)) return 'GIRO';
  if (/FAST\s+PAYMENT/.test(text)) return 'FAST payment';
  return 'payment';
}

export function probablyWasSentence(options: {
  ssicCode?: string | null;
  ssicDescription?: string | null;
  amountCents: number;
  merchantText: string;
  categoryId?: string | null;
}): string {
  const ssic = guessFromSsic(options);
  if (ssic) return ssic.probablyWas;
  const text = options.merchantText.toUpperCase();
  if (/\bATM\b/.test(text)) return 'Cash withdrawn from an ATM';
  if (/CASHIER'?S?\s*ORDER/.test(text)) return "A cashier's order";
  if (options.categoryId === 'exp.food.dining.hawker' || options.categoryId === 'exp.food.groceries' && /kopi|cafe|hawker|food/i.test(options.merchantText)) {
    if (options.categoryId === 'exp.food.groceries') return 'Groceries from a supermarket';
    return 'A meal or kopi at a coffee shop';
  }
  if (options.categoryId === 'exp.food.groceries') return 'Groceries from a supermarket';
  if (options.categoryId === 'exp.transport.ride') return 'A ride-hailing trip';
  if (options.categoryId === 'exp.transport.transit') return 'A public-transport trip';
  const parsed = parsePayeeAndUen(options.merchantText);
  if (parsed.opaque && Math.abs(options.amountCents) >= 100_000) return 'A large PayNow payment';
  if (parsed.opaque) return 'A PayNow payment';
  return 'A card payment';
}

export const NO_RESEARCH_MATCH = 'no research match';

export function citeResearchReason(options: {
  ssicCode?: string | null;
  ssicDescription?: string | null;
  amountCents: number;
  merchantText: string;
  categoryId?: string | null;
}): string {
  const ssic = guessFromSsic(options);
  if (!ssic) return NO_RESEARCH_MATCH;
  const probably = probablyWasSentence(options);
  const desc = ssicDescriptionFor(options.ssicCode, options.ssicDescription);
  if (desc) return `${desc} · ${probably}`;
  return `${ssic.rationale} · ${probably}`;
}

export function guessReasonText(options: {
  ssicCode?: string | null;
  ssicDescription?: string | null;
  amountCents: number;
  merchantText: string;
  rationale?: string | null;
  friendlyPayee?: string | null;
  researchComplete?: boolean;
  categoryId?: string | null;
}): string {
  if (options.researchComplete === false) return '';
  const cited = citeResearchReason(options);
  if (cited !== NO_RESEARCH_MATCH) return cited;
  if (options.researchComplete) return NO_RESEARCH_MATCH;
  const amount = formatSgdAmount(options.amountCents);
  const rail = railNoun(options.merchantText);
  if (options.friendlyPayee) return `${amount} ${rail} to ${options.friendlyPayee}`;
  const rationale = options.rationale?.trim();
  if (rationale && !/^opaque /i.test(rationale) && rationale !== 'test') return rationale;
  return `${amount} ${rail}`;
}

export function compatibleKind(amountCents: number, kind: CategoryKind): boolean {
  if (amountCents < 0 && kind === 'income') return false;
  if (amountCents > 0 && kind === 'expense') return false;
  return true;
}

export function guardCategoryDirection(
  schema: CategorySchema,
  categoryId: string | null,
  amountCents: number
): DirectionGuardResult {
  if (!categoryId) return { categoryId: null, blocked: false, reason: null };
  const found = findCategory(schema, categoryId);
  if (!found) return { categoryId, blocked: false, reason: null };
  if (amountCents < 0 && found.kind === 'income') {
    return {
      categoryId: null,
      blocked: true,
      reason: 'direction guard: outflow cannot be income',
    };
  }
  if (amountCents > 0 && found.kind === 'expense') {
    return {
      categoryId: null,
      blocked: true,
      reason: 'direction guard: inflow cannot be expense',
    };
  }
  return { categoryId, blocked: false, reason: null };
}
