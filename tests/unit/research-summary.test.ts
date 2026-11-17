import { describe, it, expect } from 'vitest';
import {
  THAT_DAY_EMPTY,
  buildResearchSummary,
  registeredAgeLabel,
  thatDayLine,
} from '../../src/server/services/research-summary.js';
import type { MerchantEnrichment } from '../../src/server/services/merchant-enrichment-service.js';

const PAYNOW = 'FAST PAYMENT via PayNow-UEN to ABOVE ALL ENTERP OTHR-OTHR';

const enrichment: MerchantEnrichment = {
  merchantKey: 'ABOVE ALL ENTERP OTHR OTHR',
  payeeName: 'ABOVE ALL ENTERP',
  uen: '202615975E',
  source: 'acra',
  registeredName: 'ABOVE ALL ENTERPRISE PTE. LTD.',
  entityStatus: 'Live Company',
  ssicCode: '56122',
  ssicDescription: 'na',
  registeredAddress: '206 Serangoon Central #04-158 S(550206)',
  incorporationDate: '2026-04-10',
  webDescription: null,
  sourceUrls: ['https://opengovsg.com/corporate/202615975E'],
  fetchedAt: 1,
};

describe('review research summary', () => {
  it('builds the registry entity, probably-was line, and empty That day copy', () => {
    const summary = buildResearchSummary({
      merchantText: PAYNOW,
      amountCents: -1850,
      categoryId: 'exp.food.dining.hawker',
      rationale: 'Opaque PayNow payee',
      savedPayee: null,
      snippets: [],
      enrichment,
    });
    expect(summary.probablyWas).toBe('A meal or kopi at a coffee shop');
    expect(summary.entity?.registeredName).toBe('ABOVE ALL ENTERPRISE PTE. LTD.');
    expect(summary.entity?.ssicDescription).toMatch(/coffee shop/i);
    expect(summary.entity?.address).toBe('206 Serangoon Central #04-158 S(550206)');
    expect(summary.entity?.registeredLabel).toBe('registered Apr 2026');
    expect(summary.entity?.sourceUrl).toBe('https://opengovsg.com/corporate/202615975E');
    expect(summary.entity?.sourceLabel).toBe('opengovsg');
    expect(summary.thatDay).toBe(THAT_DAY_EMPTY);
    expect(summary.suggestedPayee).toBe('Above All Enterprise');
    expect(summary.suggestedReason).toMatch(/coffee shop/i);
  });

  it('links web lookup entities to the web-result URL, not opengovsg', () => {
    const summary = buildResearchSummary({
      merchantText: PAYNOW,
      amountCents: -1850,
      categoryId: 'exp.food.dining.hawker',
      rationale: 'Opaque PayNow payee',
      savedPayee: null,
      snippets: [],
      enrichment: {
        ...enrichment,
        source: 'web',
        webDescription: 'Coffee shop operator in Serangoon',
        sourceUrls: ['https://example.com/above-all-enterprise'],
      },
    });
    expect(summary.entity?.sourceUrl).toBe('https://example.com/above-all-enterprise');
    expect(summary.entity?.sourceLabel).toBe('example.com');
  });

  it('omits the entity when ACRA missed and still shows That day', () => {
    const summary = buildResearchSummary({
      merchantText: 'FAST PAYMENT via PayNow to LIM AH HOCK OTHR-OTHR',
      amountCents: -350000,
      categoryId: 'exp.housing.utilities',
      rationale: 'Opaque PayNow payee',
      savedPayee: null,
      snippets: [],
      enrichment: null,
    });
    expect(summary.entity).toBeNull();
    expect(summary.thatDay).toBe(THAT_DAY_EMPTY);
    expect(summary.suggestedPayee).toBe('Lim Ah Hock');
    expect(summary.probablyWas).toBe('A large PayNow payment');
  });

  it('formats That day from calendar and place snippets', () => {
    expect(thatDayLine([
      { id: 'c', kind: 'calendar', snippet: 'calendar: Dinner', sourceId: 'cal', proposedSplit: null, memberName: 'Alex' },
      { id: 'p', kind: 'place', snippet: 'at Jewel Changi 2:10–2:40pm', sourceId: 'vis', proposedSplit: null, memberName: 'Alex' },
    ])).toBe('That day: Dinner · at Jewel Changi 2:10–2:40pm');
    expect(registeredAgeLabel('2026-04-10')).toBe('registered Apr 2026');
  });
});
