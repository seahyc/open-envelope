import type { Adapter, ParsedObservation, ParseResult, StatementPeriod } from '../adapter.js';
import type { ObservationKind } from '../../../shared/types.js';
import { extractStatementText, extractTextForDetection } from '../../lib/pdf-text-extractor.js';
import {
  compactDayMonthToTimestamp,
  extractHeaderYear,
  extractStatementPeriod,
} from './statement-dates.js';
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

const COMPACT_DATE = /^\s*(\d{2})([A-Z]{3})\s+(.*)$/i;
const SRS_HEADER = /SUPPLEMENTARY RETIREMENT SCHEME[\s\S]{0,400}STATEMENT OF ACCOUNT FROM:/i;

export class OcbcSrsAdapter implements Adapter {
  readonly name = 'ocbc-srs';
  readonly supportedMimeTypes = ['application/pdf', 'text/plain'];

  async canParse(content: Buffer, _filename: string, _mimeType: string): Promise<number> {
    const text = await extractTextForDetection(content);
    const header = headerRegion(text);
    if (/^From:/im.test(header)) return 0;
    if (/OCBC/i.test(header) && SRS_HEADER.test(header)) {
      return 0.95;
    }
    return 0;
  }

  async parse(content: Buffer): Promise<ParseResult> {
    const text = await extractStatementText(content);
    const accountMatch =
      text.match(/Account Number[:\s]+(\d{3}-\d+-\d+)/i) ||
      text.match(/Account No\.?\s*[:\s]+(\d{3}-\d+-\d+)/i);
    const accountHint = accountMatch ? stripAccountPunctuation(accountMatch[1]!) : 'srs';

    const period = extractStatementPeriod(text);
    const periodStart = period?.start ?? null;
    const periodEnd = period?.end ?? null;
    const headerYear = extractHeaderYear(text);

    const openingCents = lastMoneyAfterLabel(text, /BAL\.?\s*BROUGHT FORWARD/i);
    const parsed = this.parseRows(text, accountHint, periodStart, periodEnd, headerYear, openingCents);
    const closingCents = parsed.closingCents ?? lastMoneyAfterLabel(text, /BAL\.?\s*CARRIED FORWARD/i);

    let statementPeriod: StatementPeriod | undefined;
    if (openingCents !== null && closingCents !== null) {
      statementPeriod = {
        startDate: periodStart ? periodStart.getTime() : (parsed.observations[0]?.timestamp ?? 0),
        endDate: periodEnd ? periodEnd.getTime() : (parsed.observations[parsed.observations.length - 1]?.timestamp ?? 0),
        openingBalanceCents: openingCents,
        closingBalanceCents: closingCents,
        accountHint,
      };
    }

    return { observations: parsed.observations, statementPeriod };
  }

  private parseRows(
    text: string,
    accountHint: string,
    periodStart: Date | null,
    periodEnd: Date | null,
    headerYear: number | undefined,
    openingCents: number | null
  ): { observations: ParsedObservation[]; closingCents: number | null } {
    const lines = text.split(/\r?\n/);
    const observations: ParsedObservation[] = [];
    let running = openingCents;
    let seenBroughtForward = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (isLayoutNoiseLine(line)) continue;
      const row = line.match(COMPACT_DATE);
      if (!row) continue;

      const rest = row[3]!;
      const tokens = extractMoneyTokens(rest);
      const descriptionHead = rest.replace(/[\d,]+\.\d{2}/g, '').replace(/\s+/g, ' ').trim();
      if (isOpeningBalanceLabel(descriptionHead)) {
        seenBroughtForward = true;
        const last = tokens[tokens.length - 1];
        if (last && running === null) running = last.cents;
        continue;
      }
      if (isClosingBalanceLabel(descriptionHead)) {
        const last = tokens[tokens.length - 1];
        if (last) running = last.cents;
        continue;
      }
      if (!seenBroughtForward) continue;
      if (!descriptionHead || tokens.length === 0) continue;

      const sourceLine = i + 1;
      const continuation = collectContinuation(lines, i + 1, (next) => COMPACT_DATE.test(next));
      const merchant = [descriptionHead, continuation.text].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      i = continuation.nextIndex - 1;

      const signed = this.signedAmount(tokens, running);
      if (signed === null) continue;
      running = tokens[tokens.length - 1]!.cents;

      const contribution = /contribution/i.test(merchant);
      const kind: ObservationKind = contribution
        ? 'transfer'
        : kindFromBankDescription(merchant, signed.amountCents);

      observations.push({
        accountHint,
        amountCents: signed.amountCents,
        currency: 'SGD',
        timestamp: compactDayMonthToTimestamp(
          parseInt(row[1]!, 10),
          row[2]!,
          periodStart,
          periodEnd,
          headerYear
        ),
        merchantText: merchant,
        reference: contribution ? 'srs-contribution' : undefined,
        kind,
        adapterName: this.name,
        isStatement: true,
        lineOrdinal: sourceLine,
      });
    }

    return { observations, closingCents: running };
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
}
