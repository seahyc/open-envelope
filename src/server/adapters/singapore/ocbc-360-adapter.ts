import type { Adapter, ParsedObservation, ParseResult, StatementPeriod } from '../adapter.js';
import { extractStatementText, extractTextForDetection } from '../../lib/pdf-text-extractor.js';
import { extractHeaderYear, extractStatementPeriod, lineDateToTimestamp } from './statement-dates.js';
import {
  classifyMoneyColumn,
  collectContinuation,
  detectAmountColumns,
  extractMoneyTokens,
  headerRegion,
  isClosingBalanceLabel,
  isLayoutNoiseLine,
  isOpeningBalanceLabel,
  kindFromBankDescription,
  lastMoneyAfterLabel,
  stripAccountPunctuation,
  type AmountColumns,
} from './statement-layout.js';

const MONTH = 'JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC';
const TWO_DATES = new RegExp(
  `^\\s*(\\d{2})\\s+(${MONTH})\\s+(\\d{2})\\s+(${MONTH})(?:\\s+(\\d{2,4}))?\\s+(.*)$`,
  'i'
);
const ONE_DATE_YEAR = /^\s*(\d{2})\s+([A-Z]{3})\s+(\d{2,4})\s+(.*)$/i;
const ONE_DATE = /^\s*(\d{2})\s+([A-Z]{3})\s+(.*)$/i;
const SRS_HEADER = /SUPPLEMENTARY RETIREMENT SCHEME[\s\S]{0,400}STATEMENT OF ACCOUNT FROM:/i;

interface BankRow {
  dateStr: string;
  rest: string;
}

export class Ocbc360Adapter implements Adapter {
  readonly name = 'ocbc-360';
  readonly supportedMimeTypes = ['application/pdf', 'text/plain'];

  async canParse(content: Buffer, _filename: string, _mimeType: string): Promise<number> {
    const text = await extractTextForDetection(content);
    const header = headerRegion(text);
    if (/^From:/im.test(header) || /transaction alert/i.test(header)) {
      return 0;
    }
    if (SRS_HEADER.test(header)) {
      return 0;
    }
    if (/LAST MONTH'?S BALANCE|TOTAL AMOUNT DUE|Card Number\b/i.test(header)) {
      return 0;
    }
    const isOcbc = /OCBC/i.test(header);
    const isBankAccount =
      /360\b/i.test(header) ||
      /Statement Savings/i.test(header) ||
      (/BALANCE B\/F/i.test(header) && /BALANCE C\/F/i.test(header));
    const hasAccountMeta = /(Opening Balance|Statement Period|Account Number|Account No)/i.test(header);
    if (isOcbc && isBankAccount && hasAccountMeta) {
      return 0.9;
    }
    return 0;
  }

  async parse(content: Buffer): Promise<ParseResult> {
    const text = await extractStatementText(content);

    const accountMatch =
      text.match(/Account Number[:\s]+(\d{3}-\d+-\d+)/i) ||
      text.match(/Account No\.?\s*[:\s]+(\d{3}-\d+-\d+)/i);
    const accountHint = accountMatch ? stripAccountPunctuation(accountMatch[1]!) : 'unknown';

    const period = extractStatementPeriod(text);
    const periodStart = period?.start ?? null;
    const periodEnd = period?.end ?? null;
    const headerYear = extractHeaderYear(text);

    const { openingCents, closingCents } = this.extractBalances(text);
    const columns = detectAmountColumns(text);
    const observations = this.parseRows(
      text,
      accountHint,
      periodStart,
      periodEnd,
      headerYear,
      openingCents,
      columns
    );

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

  private extractBalances(text: string): { openingCents: number | null; closingCents: number | null } {
    const openingCents =
      lastMoneyAfterLabel(text, /BALANCE B\/F/i) ??
      lastMoneyAfterLabel(text, /Opening Balance/i);
    const closingCents =
      lastMoneyAfterLabel(text, /BALANCE C\/F/i) ??
      lastMoneyAfterLabel(text, /Closing Balance/i);
    return { openingCents, closingCents };
  }

  private parseRows(
    text: string,
    accountHint: string,
    periodStart: Date | null,
    periodEnd: Date | null,
    headerYear: number | undefined,
    openingCents: number | null,
    columns: AmountColumns | null
  ): ParsedObservation[] {
    const lines = text.split(/\r?\n/);
    const observations: ParsedObservation[] = [];
    let running = openingCents;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (isLayoutNoiseLine(line)) continue;
      const row = this.matchRow(line);
      if (!row) continue;

      const sourceLine = i + 1;
      const continuation = collectContinuation(lines, i + 1, (next) => this.matchRow(next) !== null);
      const combined = [row.rest, continuation.text].filter(Boolean).join(' ');
      const amountLine = extractMoneyTokens(line).length >= 1 ? line : `${line} ${continuation.text}`;
      const tokens = extractMoneyTokens(amountLine);
      const merchant = combined.replace(/[\d,]+\.\d{2}/g, '').replace(/\s+/g, ' ').trim();
      i = continuation.nextIndex - 1;
      if (isOpeningBalanceLabel(merchant) || isClosingBalanceLabel(merchant)) {
        const last = tokens[tokens.length - 1];
        if (last && isOpeningBalanceLabel(merchant) && running === null) {
          running = last.cents;
        }
        continue;
      }
      if (!merchant || tokens.length === 0) continue;

      const signed = this.signedAmount(tokens, running, columns);
      if (signed === null) continue;
      running = signed.newRunning;

      observations.push({
        accountHint,
        amountCents: signed.amountCents,
        currency: 'SGD',
        timestamp: lineDateToTimestamp(row.dateStr, periodStart, periodEnd, headerYear),
        merchantText: merchant,
        kind: kindFromBankDescription(merchant, signed.amountCents),
        adapterName: this.name,
        isStatement: true,
        lineOrdinal: sourceLine,
      });
    }

    return observations;
  }

  private matchRow(line: string): BankRow | null {
    const two = line.match(TWO_DATES);
    if (two) {
      return { dateStr: `${two[1]} ${two[2]}`, rest: two[6]!.trim() };
    }
    const withYear = line.match(ONE_DATE_YEAR);
    if (withYear) {
      return { dateStr: `${withYear[1]} ${withYear[2]} ${withYear[3]}`, rest: withYear[4]!.trim() };
    }
    const one = line.match(ONE_DATE);
    if (one) {
      return { dateStr: `${one[1]} ${one[2]}`, rest: one[3]!.trim() };
    }
    return null;
  }

  private signedAmount(
    tokens: { cents: number; index: number }[],
    running: number | null,
    columns: AmountColumns | null
  ): { amountCents: number; newRunning: number } | null {
    if (tokens.length === 0) return null;
    const balanceToken =
      [...tokens].reverse().find((token) => classifyMoneyColumn(token.index, columns) === 'balance') ??
      tokens[tokens.length - 1]!;
    const balance = balanceToken.cents;
    if (running !== null) {
      return { amountCents: balance - running, newRunning: balance };
    }
    const withdrawals = tokens.filter((token) => classifyMoneyColumn(token.index, columns) === 'withdrawal');
    const deposits = tokens.filter((token) => classifyMoneyColumn(token.index, columns) === 'deposit');
    if (withdrawals.length || deposits.length) {
      const withdrawal = withdrawals.reduce((sum, token) => sum + token.cents, 0);
      const deposit = deposits.reduce((sum, token) => sum + token.cents, 0);
      return { amountCents: deposit - withdrawal, newRunning: balance };
    }
    if (tokens.length >= 3) {
      return { amountCents: tokens[0]!.cents > 0 ? -tokens[0]!.cents : tokens[1]!.cents, newRunning: balance };
    }
    if (tokens.length === 2) {
      return { amountCents: -tokens[0]!.cents, newRunning: balance };
    }
    return null;
  }
}
