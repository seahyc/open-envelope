import type { Adapter, ParsedObservation, ParseResult, StatementPeriod } from '../adapter.js';
import { extractStatementText, extractTextForDetection } from '../../lib/pdf-text-extractor.js';
import { extractHeaderYear, extractStatementPeriod, lineDateToTimestamp } from './statement-dates.js';
import {
  collectContinuation,
  extractMoneyTokens,
  headerRegion,
  isClosingBalanceLabel,
  isLayoutNoiseLine,
  isOpeningBalanceLabel,
  kindFromBankDescription,
  lastMoneyAfterLabel,
  stripAccountPunctuation,
} from './statement-layout.js';

const NUMERIC_DATE = /^\s*(\d{2}\/\d{2}\/\d{4})\s+(.*)$/;
const NAMED_DATE = /^\s*(\d{2}\s+[A-Z]{3})\s+(.*)$/i;
const NEXT_ACCOUNT = /^\s*(POSB|DBS)\s+\S+.*Account\b|^\s*(Multiplier|Current|Savings|eSavings)\s+Account\b/i;

export class DbsAccountAdapter implements Adapter {
  readonly name = 'dbs-account';
  readonly supportedMimeTypes = ['application/pdf', 'text/plain'];

  async canParse(content: Buffer, _filename: string, _mimeType: string): Promise<number> {
    const text = await extractTextForDetection(content);
    const header = headerRegion(text);
    const hasBank = /DBS|POSB/i.test(header);
    const hasCard = /Credit Card|Card ending|Card Number|CARD NO\.?|Altitude/i.test(header);

    if (/^From:/im.test(header)) {
      return 0;
    }
    if (hasBank && !hasCard && /(eSavings|Balance Brought Forward|Opening Balance|Statement Period|Statement Date|Total Balance Carried Forward)/i.test(header)) {
      return 0.9;
    }
    return 0;
  }

  async parse(content: Buffer): Promise<ParseResult> {
    const text = await extractStatementText(content);
    const section = this.extractEsavingsSection(text) ?? text;

    const accountMatch =
      section.match(/Account No\.?\s*[:\s]+(\d{3}-\d{5}-\d)/i) ||
      section.match(/Account[:\s]+(\d{3}-\d{5}-\d)/i) ||
      section.match(/(\d{3}-\d{5}-\d)/);
    const accountHint = accountMatch ? stripAccountPunctuation(accountMatch[1]!) : 'unknown';

    const period = extractStatementPeriod(text);
    const periodStart = period?.start ?? null;
    const periodEnd = period?.end ?? null;
    const headerYear = extractHeaderYear(text);

    const { openingCents, closingCents } = this.extractBalances(section);
    const observations = this.parseRows(section, accountHint, periodStart, periodEnd, headerYear, openingCents);

    let statementPeriod: StatementPeriod | undefined;
    if (openingCents !== null && closingCents !== null) {
      statementPeriod = {
        startDate: periodStart ? periodStart.getTime() : (observations[0]?.timestamp ?? 0),
        endDate: periodEnd ? periodEnd.getTime() : (observations[observations.length - 1]?.timestamp ?? 0),
        openingBalanceCents: openingCents,
        closingBalanceCents: closingCents,
        accountHint,
      };
    }

    return { observations, statementPeriod };
  }

  private extractEsavingsSection(text: string): string | null {
    const detailsIdx = text.search(/Transaction Details/i);
    if (detailsIdx >= 0) {
      const afterDetails = text.slice(detailsIdx);
      const start = afterDetails.search(/POSB eSavings Account|eSavings Account/i);
      if (start >= 0) {
        return this.sliceUntilNextAccount(afterDetails.slice(start));
      }
    }
    const fallbackStart = text.search(/POSB eSavings Account|eSavings Account/i);
    if (fallbackStart < 0) return null;
    return this.sliceUntilNextAccount(text.slice(fallbackStart));
  }

  private sliceUntilNextAccount(rest: string): string {
    const lines = rest.split(/\r?\n/);
    const kept: string[] = [lines[0] ?? ''];
    for (let i = 1; i < lines.length; i++) {
      if (NEXT_ACCOUNT.test(lines[i]!.trim()) && !/eSavings/i.test(lines[i]!)) {
        break;
      }
      kept.push(lines[i]!);
    }
    return kept.join('\n');
  }

  private extractBalances(text: string): { openingCents: number | null; closingCents: number | null } {
    const openingCents =
      lastMoneyAfterLabel(text, /Balance Brought Forward/i) ??
      lastMoneyAfterLabel(text, /Opening Balance/i);
    const closingCents =
      lastMoneyAfterLabel(text, /Total Balance Carried Forward/i) ??
      lastMoneyAfterLabel(text, /Balance Carried Forward/i) ??
      lastMoneyAfterLabel(text, /Closing Balance/i);
    if (openingCents !== null || closingCents !== null) {
      return { openingCents, closingCents };
    }
    const summary = this.summarySgdBalance(text);
    return { openingCents: summary, closingCents: summary };
  }

  private summarySgdBalance(text: string): number | null {
    for (const line of text.split(/\r?\n/)) {
      if (!/eSavings Account/i.test(line) || !/SGD/i.test(line)) continue;
      const tokens = extractMoneyTokens(line);
      if (tokens.length === 0) continue;
      return tokens[tokens.length - 1]!.cents;
    }
    return null;
  }

  private parseRows(
    text: string,
    accountHint: string,
    periodStart: Date | null,
    periodEnd: Date | null,
    headerYear: number | undefined,
    openingCents: number | null
  ): ParsedObservation[] {
    const lines = text.split(/\r?\n/);
    const observations: ParsedObservation[] = [];
    let running = openingCents;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (isLayoutNoiseLine(line)) continue;
      const row = this.matchRow(line);
      if (!row) continue;

      const tokens = extractMoneyTokens(row.rest);
      const descriptionHead = row.rest.replace(/[\d,]+\.\d{2}/g, '').replace(/\s+/g, ' ').trim();
      if (isOpeningBalanceLabel(descriptionHead) || isClosingBalanceLabel(descriptionHead)) {
        const last = tokens[tokens.length - 1];
        if (last && isOpeningBalanceLabel(descriptionHead) && running === null) {
          running = last.cents;
        }
        continue;
      }
      if (!descriptionHead || tokens.length === 0) continue;

      const sourceLine = i + 1;
      const continuation = collectContinuation(lines, i + 1, (next) => this.matchRow(next) !== null);
      const merchant = [descriptionHead, continuation.text].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      i = continuation.nextIndex - 1;

      const signed = this.signedAmount(tokens, running);
      if (signed === null) continue;
      if (running !== null && tokens.length >= 1) {
        running = tokens[tokens.length - 1]!.cents;
      } else if (running !== null) {
        running += signed.amountCents;
      }

      observations.push({
        accountHint,
        amountCents: signed.amountCents,
        currency: 'SGD',
        timestamp: row.numeric
          ? this.parseNumericDate(row.dateStr)
          : lineDateToTimestamp(row.dateStr, periodStart, periodEnd, headerYear),
        merchantText: merchant,
        kind: kindFromBankDescription(merchant, signed.amountCents),
        adapterName: this.name,
        isStatement: true,
        lineOrdinal: sourceLine,
      });
    }

    return observations;
  }

  private matchRow(line: string): { dateStr: string; rest: string; numeric: boolean } | null {
    const numeric = line.match(NUMERIC_DATE);
    if (numeric) {
      return { dateStr: numeric[1]!, rest: numeric[2]!.trim(), numeric: true };
    }
    const named = line.match(NAMED_DATE);
    if (named) {
      return { dateStr: named[1]!, rest: named[2]!.trim(), numeric: false };
    }
    return null;
  }

  private signedAmount(
    tokens: { cents: number }[],
    running: number | null
  ): { amountCents: number } | null {
    if (tokens.length === 0) return null;
    const balance = tokens[tokens.length - 1]!.cents;
    if (running !== null) {
      return { amountCents: balance - running };
    }
    if (tokens.length >= 2) {
      return { amountCents: -tokens[0]!.cents };
    }
    return null;
  }

  private parseNumericDate(dateStr: string): number {
    const parts = dateStr.split('/');
    if (parts.length !== 3) return 0;
    return new Date(parseInt(parts[2]!, 10), parseInt(parts[1]!, 10) - 1, parseInt(parts[0]!, 10)).getTime();
  }
}
