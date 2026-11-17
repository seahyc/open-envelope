import type { Adapter, ParsedObservation, ParseResult, StatementPeriod } from '../adapter.js';
import type { ObservationKind } from '../../../shared/types.js';
import { extractStatementText, extractTextForDetection } from '../../lib/pdf-text-extractor.js';
import {
  extractHeaderYear,
  extractStatementDate,
  extractStatementPeriod,
  lineDateToTimestamp,
} from './statement-dates.js';
import {
  collectContinuation,
  extractMoneyTokens,
  hasPrefixedCurrencyAmount,
  headerRegion,
  isCardSummaryLine,
  isDbsCardTableHeader,
  isLayoutNoiseLine,
  isNonTransactionLabel,
  last4FromDigits,
  lastMoneyAfterLabel,
} from './statement-layout.js';

const NAMED_DATE = /^\s*(\d{2})\s+([A-Z]{3})\s+(.*)$/i;
const TWO_NUMERIC_DATES = /^\s*(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})\s+(.*)$/;

export class DbsCardAdapter implements Adapter {
  readonly name = 'dbs-card';
  readonly supportedMimeTypes = ['application/pdf', 'text/plain'];

  async canParse(content: Buffer, _filename: string, _mimeType: string): Promise<number> {
    const text = await extractTextForDetection(content);
    const header = headerRegion(text);
    if (/^From:/im.test(header) || /transaction alert|PayLah/i.test(header)) {
      return 0;
    }
    if (/POSB eSavings|Balance Brought Forward|Multiplier Account/i.test(header)) {
      return 0;
    }
    const hasBank = /DBS|POSB/i.test(header);
    const hasCard = /Credit Card|Card ending|Card Number|CARD NO\.?|Visa Credit|Altitude/i.test(header);
    if (hasBank && hasCard && /(Previous Balance|PREVIOUS BALANCE|New Balance|\bTOTAL:|Trans Date|Post Date|STATEMENT DATE)/i.test(header)) {
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
    const periodStart = period?.start ?? (statementDate ? new Date(statementDate.getFullYear(), statementDate.getMonth(), 1) : null);
    const periodEnd = period?.end ?? statementDate ?? null;

    const observations = this.parseRows(text, accountHint, periodStart, periodEnd, headerYear);
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
    const ending = text.match(/Card ending[:\s]+(\d{4})/i);
    if (ending) return `card-${ending[1]!}`;
    const cardNo = text.match(/CARD NO\.?:?\s*([\d\s.xX*]+)/i);
    if (cardNo) return `card-${last4FromDigits(cardNo[1]!)}`;
    return 'unknown';
  }

  private extractBalances(text: string): { openingCents: number | null; closingCents: number | null } {
    const previousLine = this.balanceLine(text, /PREVIOUS BALANCE|Previous Balance/i);
    const totalLine = this.balanceLine(text, /(?:^|\n)\s*TOTAL:/i) ?? this.balanceLine(text, /New Balance/i);
    return {
      openingCents: previousLine ? this.creditBalanceFromLine(previousLine) : null,
      closingCents: totalLine ? this.creditBalanceFromLine(totalLine) : null,
    };
  }

  private balanceLine(text: string, label: RegExp): string | null {
    for (const line of text.split(/\r?\n/)) {
      if (label.test(line) && extractMoneyTokens(line).length > 0) return line;
    }
    const cents = lastMoneyAfterLabel(text, label);
    return cents !== null ? String((cents / 100).toFixed(2)) : null;
  }

  private creditBalanceFromLine(line: string): number {
    const token = extractMoneyTokens(line).pop();
    if (!token) {
      const cents = Math.round(parseFloat(line.replace(/,/g, '')) * 100);
      return Number.isNaN(cents) ? 0 : -Math.abs(cents);
    }
    return token.cr || token.inParens ? Math.abs(token.cents) : -Math.abs(token.cents);
  }

  private parseRows(
    text: string,
    accountHint: string,
    periodStart: Date | null,
    periodEnd: Date | null,
    headerYear: number | undefined
  ): ParsedObservation[] {
    const lines = text.split(/\r?\n/);
    const observations: ParsedObservation[] = [];
    const hasTableHeader = lines.some((line) => isDbsCardTableHeader(line));
    let inTable = !hasTableHeader;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (isDbsCardTableHeader(line)) {
        inTable = true;
        continue;
      }
      if (!inTable) continue;
      if (/^\s*(GRAND\s+TOTAL|TOTAL:)\b/i.test(line)) break;
      if (isCardSummaryLine(line) || isLayoutNoiseLine(line)) continue;
      const parsed = this.matchRow(line, periodStart, periodEnd, headerYear);
      if (!parsed) continue;
      if (isNonTransactionLabel(parsed.merchant) || isNonTransactionLabel(line)) continue;

      const sourceLine = i + 1;
      const continuation = collectContinuation(
        lines,
        i + 1,
        (next) => this.matchRow(next, periodStart, periodEnd, headerYear) !== null
      );
      i = continuation.nextIndex - 1;
      const merchant = [parsed.merchant, continuation.text].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      const kind: ObservationKind = parsed.amountCents < 0 ? 'purchase' : 'refund';

      observations.push({
        accountHint,
        amountCents: parsed.amountCents,
        currency: 'SGD',
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
    headerYear: number | undefined
  ): { timestamp: number; merchant: string; amountCents: number } | null {
    if (hasPrefixedCurrencyAmount(line) || /^\s*\d{2}\s+[A-Z]{3}\s+\d{4}\b/i.test(line)) {
      return null;
    }
    const numeric = line.match(TWO_NUMERIC_DATES);
    if (numeric) {
      const tokens = extractMoneyTokens(numeric[3]!);
      if (tokens.length === 0) return null;
      const amount = tokens[tokens.length - 1]!;
      const merchant = numeric[3]!.slice(0, amount.index).replace(/\bSGD\b/g, '').replace(/\s+/g, ' ').trim();
      if (!merchant) return null;
      const amountCents = amount.cr || amount.inParens ? Math.abs(amount.cents) : -Math.abs(amount.cents);
      return { timestamp: this.parseNumericDate(numeric[2]!), merchant, amountCents };
    }

    const named = line.match(NAMED_DATE);
    if (named) {
      const rest = named[3]!;
      const tokens = extractMoneyTokens(rest);
      if (tokens.length === 0) return null;
      const amount = tokens[tokens.length - 1]!;
      const merchant = rest.slice(0, amount.index).replace(/\s+/g, ' ').trim();
      if (!merchant || isNonTransactionLabel(merchant)) return null;
      if (/^CARD NO/i.test(merchant) || /STATEMENT DATE/i.test(merchant)) return null;
      const amountCents = amount.cr || amount.inParens ? Math.abs(amount.cents) : -Math.abs(amount.cents);
      return {
        timestamp: lineDateToTimestamp(`${named[1]} ${named[2]}`, periodStart, periodEnd, headerYear),
        merchant,
        amountCents,
      };
    }

    return null;
  }

  private parseNumericDate(dateStr: string): number {
    const parts = dateStr.split('/');
    if (parts.length !== 3) return 0;
    return new Date(parseInt(parts[2]!, 10), parseInt(parts[1]!, 10) - 1, parseInt(parts[0]!, 10)).getTime();
  }
}
