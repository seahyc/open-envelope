import type { ContextSnippet } from './context/triangulate.js';
import {
  cleanedPayeeDisplay,
  displayMerchantName,
  friendlyRegisteredName,
  opengovsgCorporateUrl,
} from './display-name.js';
import type { MerchantEnrichment } from './merchant-enrichment-service.js';
import { guessReasonText, probablyWasSentence, ssicDescriptionFor } from './ssic-guess.js';

export const THAT_DAY_EMPTY = 'That day: nothing on your calendars · no location recorded';

export interface ReviewEntity {
  registeredName: string;
  ssicDescription: string | null;
  address: string | null;
  registeredLabel: string | null;
  sourceUrl: string | null;
  sourceLabel: string;
}

export interface ResearchSummary {
  probablyWas: string;
  entity: ReviewEntity | null;
  thatDay: string;
  suggestedPayee: string;
  suggestedReason: string;
}

export function registeredAgeLabel(isoDate: string | null | undefined): string | null {
  if (!isoDate) return null;
  const match = isoDate.trim().match(/^(\d{4})-(\d{2})/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!year || !month) return null;
  const label = new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('en-SG', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return `registered ${label}`;
}

export function thatDayLine(snippets: ContextSnippet[]): string {
  const calendar = snippets.find((snippet) => snippet.kind === 'calendar');
  const place = snippets.find((snippet) => snippet.kind === 'place');
  if (!calendar && !place) return THAT_DAY_EMPTY;
  const parts: string[] = [];
  if (calendar) parts.push(calendar.snippet.replace(/^calendar:\s*/i, ''));
  if (place) parts.push(place.snippet);
  return `That day: ${parts.join(' · ')}`;
}

export function buildResearchSummary(options: {
  merchantText: string;
  amountCents: number | null;
  categoryId: string | null;
  rationale: string | null;
  savedPayee: string | null;
  snippets: ContextSnippet[];
  enrichment: MerchantEnrichment | null;
  researchComplete?: boolean;
}): ResearchSummary {
  const amountCents = options.amountCents ?? 0;
  const suggestedPayee = displayMerchantName({
    savedPayee: options.savedPayee,
    registeredName: options.enrichment?.registeredName,
    merchantText: options.merchantText,
  }) || cleanedPayeeDisplay(options.merchantText);
  const ssicCode = options.enrichment?.ssicCode ?? null;
  const ssicDescription = ssicDescriptionFor(ssicCode, options.enrichment?.ssicDescription);
  return {
    probablyWas: probablyWasSentence({
      ssicCode,
      ssicDescription,
      amountCents,
      merchantText: options.merchantText,
      categoryId: options.categoryId,
    }),
    entity: entityFromEnrichment(options.enrichment, ssicDescription),
    thatDay: thatDayLine(options.snippets),
    suggestedPayee,
    suggestedReason: guessReasonText({
      ssicCode,
      ssicDescription,
      amountCents,
      merchantText: options.merchantText,
      rationale: options.rationale,
      friendlyPayee: suggestedPayee,
      researchComplete: options.researchComplete,
      categoryId: options.categoryId,
    }),
  };
}

function entityFromEnrichment(
  enrichment: MerchantEnrichment | null,
  ssicDescription: string | null
): ReviewEntity | null {
  if (!enrichment?.registeredName) return null;
  const { sourceUrl, sourceLabel } = entitySourceLink(enrichment);
  return {
    registeredName: enrichment.registeredName,
    ssicDescription,
    address: enrichment.registeredAddress,
    registeredLabel: registeredAgeLabel(enrichment.incorporationDate),
    sourceUrl,
    sourceLabel,
  };
}

export function entitySourceLink(enrichment: MerchantEnrichment): { sourceUrl: string | null; sourceLabel: string } {
  if (enrichment.source === 'web') {
    const url = enrichment.sourceUrls.find((entry) => Boolean(entry?.trim())) ?? null;
    return { sourceUrl: url, sourceLabel: url ? sourceHost(url) : 'web' };
  }
  const uen = enrichment.uen?.trim() || null;
  if (uen) {
    return { sourceUrl: opengovsgCorporateUrl(uen), sourceLabel: 'opengovsg' };
  }
  const url = enrichment.sourceUrls.find((entry) => Boolean(entry?.trim())) ?? null;
  return {
    sourceUrl: url,
    sourceLabel: url && /opengovsg\.com/i.test(url) ? 'opengovsg' : sourceHost(url),
  };
}

function sourceHost(url: string | null): string {
  if (!url) return 'source';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'source';
  }
}

export { friendlyRegisteredName };
