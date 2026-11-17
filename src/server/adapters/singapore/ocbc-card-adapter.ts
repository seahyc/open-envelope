import type { Adapter, ParsedObservation, ParseResult, StatementPeriod } from '../adapter.js';
import type { ObservationKind } from '../../../shared/types.js';
import { extractStatementText, extractTextForDetection } from '../../lib/pdf-text-extractor.js';
import {
  cardCycleFromStatementDate,
  extractHeaderYear,
  extractStatementDate,
  extractStatementPeriod,
  lineDateToTimestamp,
  yearForMonthAgainstAnchor,
} from './statement-dates.js';
import {
  collectContinuation,
  extractMoneyTokens,
  hasPrefixedCurrencyAmount,
  headerRegion,
  isCardSummaryLine,
  isLayoutNoiseLine,
  isNonTransactionLabel,
  isOcbcCardTableHeader,
  last4FromDigits,
  lastMoneyAfterLabel,
} from './statement-layout.js';

const SLASH_DATE = /^\s*(\d{2})[\/\-](\d{2})(?:[\/\-](\d{2,4}))?\s+(.*)$/;
const TWO_NAMED_DATES = /^\s*(\d{2}\s+[A-Z]{3})\s+(\d{2}\s+[A-Z]{3})\s+(.*)$/i;
const SRS_HEADER = /SUPPLEMENTARY RETIREMENT SCHEME[\s\S]{0,400}STATEMENT OF ACCOUNT FROM:/i;

export class OcbcCardAdapter implements Adapter {
  readonly name = 'ocbc-card';
  readonly supportedMimeTypes = ['application/pdf', 'text/plain'];

  async canParse(content: Buffer, _filename: string, _mimeType: string): Promise<number> {
    const text = await extractTextForDetection(content);
    const header = headerRegion(text);
    if (/OCBC/i.test(header) && (/360\b/i.test(header) || /Statement Savings/i.test(header) || /BALANCE B\/F/i.test(header))) {
      return 0;
    }
    if (SRS_HEADER.test(header)) {
      return 0;
    }
    if (/^From:/im.test(header) || /transaction alert/i.test(header)) {
      return 0;
    }
    if (
      /OCBC/i.test(header) &&
      /(Card Number|LAST MONTH'?S BALANCE|TOTAL AMOUNT DUE|Credit Card|\d{4}[-\s]\d{4}[-\s]\d{4}[-\s]\d{4})/i.test(header)
    ) {
      return 0.9;
    }
    return 0;
  }

  async parse(content: Buffer): Promise<ParseResult> {
    const text = await extractStatementText(content);
    const accountHint = this.extractAccountHint(text);

    const period = extractStatementPeriod(text);
    const statementDate = extractStatementDate(text);
    const headerYear = extractHeaderYear(text);
    const cycle = period ?? (statementDate ? cardCycleFromStatementDate(statementDate) : null);
    const periodStart = cycle?.start ?? null;
    const periodEnd = cycle?.end ?? statementDate ?? null;
    const yearAnchor = statementDate ?? periodEnd;

    const observations = this.parseRows(text, accountHint, periodStart, periodEnd, headerYear, yearAnchor);
    const balances = this.extractBalances(text);

    let statementPeriod: StatementPeriod | undefined;
    if (balances.openingCents !== null && balances.closingCents !== null) {
      statementPeriod = {
        startDate: periodStart ? periodStart.getTime() : (observations[0]?.timestamp ?? 0),
        endDate: periodEnd ? periodEnd.getTime() : (observations[observations.length - 1]?.timestamp ?? 0),
        openingBalanceCents: balances.openingCents,
        closingBalanceCents: balances.closingCents,
        accountHint,
      };
    }

    return { observations, statementPeriod };
  }

  private extractAccountHint(text: string): string {
    const labelled = text.match(/Card Number[:\s]+([\d\s-]+)/i);
    if (labelled) {
      return `card-${last4FromDigits(labelled[1]!)}`;
    }
    const bare = text.match(/\b(\d{4}[-\s]\d{4}[-\s]\d{4}[-\s]\d{4})\b/);
    if (bare) {
      return `card-${last4FromDigits(bare[1]!)}`;
    }
    return 'unknown';
  }

  private extractBalances(text: string): { openingCents: number | null; closingCents: number | null } {
    const lastMonth = lastMoneyAfterLabel(text, /LAST MONTH'?S BALANCE/i);
    const previous = lastMoneyAfterLabel(text, /Previous Balance/i);
    const totalAmountDue = lastMoneyAfterLabel(text, /TOTAL AMOUNT DUE/i);
    const newBalance = lastMoneyAfterLabel(text, /New Balance/i);
    const standaloneTotal = lastMoneyAfterLabel(text, /^\s*TOTALS?\s*:?\s*[\d,(]/i);
    const opening = lastMonth ?? previous;
    const closing = totalAmountDue ?? newBalance ?? standaloneTotal;
    return {
      openingCents: opening !== null ? -Math.abs(opening) : null,
      closingCents: closing !== null ? -Math.abs(closing) : null,
    };
  }

  private parseRows(
    text: string,
    accountHint: string,
    periodStart: Date | null,
    periodEnd: Date | null,
    headerYear: number | undefined,
    yearAnchor: Date | null
  ): ParsedObservation[] {
    const lines = text.split(/\r?\n/);
    const observations: ParsedObservation[] = [];
    const hasTableHeader = lines.some((line) => isOcbcCardTableHeader(line));
    let inTable = !hasTableHeader;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (isOcbcCardTableHeader(line)) {
        inTable = true;
        continue;
      }
      if (!inTable) continue;
      if (/^\s*TOTAL AMOUNT DUE\b/i.test(line)) break;
      if (isCardSummaryLine(line) || isLayoutNoiseLine(line)) continue;
      const parsed = this.matchRow(line, periodStart, periodEnd, headerYear, yearAnchor);
      if (!parsed) continue;
      if (isNonTransactionLabel(parsed.merchant)) continue;

      const sourceLine = i + 1;
      const continuation = collectContinuation(
        lines,
        i + 1,
        (next) => this.matchRow(next, periodStart, periodEnd, headerYear, yearAnchor) !== null
      );
      i = continuation.nextIndex - 1;

      const combined = [parsed.merchant, continuation.text].filter(Boolean).join(' ');
      const tokens = extractMoneyTokens(combined);
      const fallbackAmount = tokens[tokens.length - 1];
      if (parsed.amountCents === null && !fallbackAmount) continue;

      const amountCents = parsed.amountCents !== null
        ? parsed.amountCents
        : fallbackAmount!.inParens || fallbackAmount!.cr
          ? Math.abs(fallbackAmount!.cents)
          : -Math.abs(fallbackAmount!.cents);

      let merchant = combined
        .replace(/\((?:\s*)[\d,]+\.\d{2}(?:\s*)\)/g, '')
        .replace(/[\d,]+\.\d{2}(?:\s*CR)?/g, '')
        .replace(/\s+/g, ' ')
        .trim();

      let fxAmountCents: number | undefined;
      let fxCurrency: string | undefined;
      const fx = combined.match(/FOREIGN CURRENCY\s+([A-Z]{3})\s+([\d,]+\.\d{2})/i);
      if (fx) {
        fxCurrency = fx[1];
        fxAmountCents = Math.round(parseFloat(fx[2]!.replace(/,/g, '')) * 100);
        merchant = merchant
          .replace(/FOREIGN CURRENCY\s+[A-Z]{3}/i, '')
          .replace(/FOR:\s*SGD/i, '')
          .replace(/\s+/g, ' ')
          .trim();
      }
      if (!merchant || isNonTransactionLabel(merchant)) continue;

      const kind: ObservationKind = amountCents < 0 ? 'purchase' : 'refund';
      observations.push({
        accountHint,
        amountCents,
        currency: 'SGD',
        fxAmountCents,
        fxCurrency,
        timestamp: parsed.timestamp,
        merchantText: merchant,
        kind,
        adapterName: this.name,
        isStatement: true,
        lineOrdinal: sourceLine,
      });
    }

    return observations;
  }

  private matchRow(
    line: string,
    periodStart: Date | null,
    periodEnd: Date | null,
    headerYear: number | undefined,
    yearAnchor: Date | null
  ): { timestamp: number; merchant: string; amountCents: number | null } | null {
    if (hasPrefixedCurrencyAmount(line) || /^\s*\d{2}-\d{2}-\d{4}\b/.test(line)) {
      return null;
    }
    const slash = line.match(SLASH_DATE);
    if (slash) {
      const rest = slash[4]!.trim();
      if (!rest) return null;
      const tokens = extractMoneyTokens(rest);
      const amount = tokens[tokens.length - 1];
      const merchant = (amount ? rest.slice(0, amount.index) : rest).replace(/\s+/g, ' ').trim();
      if (!merchant) return null;
      const month = parseInt(slash[2]!, 10) - 1;
      const day = parseInt(slash[1]!, 10);
      let year: number;
      if (slash[3]) {
        year = parseInt(slash[3]!, 10);
        if (year < 100) year += 2000;
      } else if (yearAnchor) {
        year = yearForMonthAgainstAnchor(month, yearAnchor);
      } else if (periodStart && periodEnd) {
        year = periodStart.getFullYear() === periodEnd.getFullYear()
          ? periodStart.getFullYear()
          : month >= periodStart.getMonth()
            ? periodStart.getFullYear()
            : periodEnd.getFullYear();
      } else {
        year = headerYear ?? 1970;
      }
      const amountCents = amount
        ? amount.inParens || amount.cr
          ? Math.abs(amount.cents)
          : -Math.abs(amount.cents)
        : null;
      return { timestamp: new Date(year, month, day).getTime(), merchant, amountCents };
    }

    const named = line.match(TWO_NAMED_DATES);
    if (named) {
      const tokens = extractMoneyTokens(named[3]!);
      const amount = tokens[tokens.length - 1];
      const merchant = (amount ? named[3]!.slice(0, amount.index) : named[3]!).replace(/\s+/g, ' ').trim();
      if (!merchant || isNonTransactionLabel(merchant)) return null;
      const amountCents = amount
        ? amount.inParens || amount.cr
          ? Math.abs(amount.cents)
          : -Math.abs(amount.cents)
        : null;
      return {
        timestamp: lineDateToTimestamp(named[2]!, periodStart, periodEnd, headerYear),
        merchant,
        amountCents,
      };
    }

    return null;
  }
}
