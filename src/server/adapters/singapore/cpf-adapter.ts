import type { Adapter, ParsedObservation, ParseResult, StatementPeriod } from '../adapter.js';
import { extractTextForDetection } from '../../lib/pdf-text-extractor.js';
import { headerRegion } from './statement-layout.js';

const CPF_HEADER =
  /Central Provident Fund Board|CPF Board|CPF\s+(Contribution\s+)?Statement|CENTRAL PROVIDENT FUND/i;

export class CpfAdapter implements Adapter {
  readonly name = 'cpf';
  readonly supportedMimeTypes = ['text/csv', 'text/plain', 'application/pdf'];

  async canParse(content: Buffer, filename: string, _mimeType: string): Promise<number> {
    const text = await extractTextForDetection(content);
    const header = headerRegion(text);
    if (/CPF Investment Scheme/i.test(text) && !CPF_HEADER.test(header)) {
      return 0;
    }
    if (CPF_HEADER.test(header)) {
      return 0.9;
    }
    if (
      /Ordinary Account\s*\(OA\)/i.test(header) &&
      /Special Account\s*\(SA\)/i.test(header) &&
      /Medisave Account\s*\(MA\)/i.test(header)
    ) {
      return 0.9;
    }
    if (filename.toLowerCase().includes('cpf') && /Date,Description,Amount,Account Type/i.test(text)) {
      return 0.8;
    }
    return 0;
  }

  async parse(content: Buffer): Promise<ParseResult> {
    const text = content.toString('utf-8');
    const lines = text.split('\n').filter((line) => line.trim());

    if (lines.length < 2) return { observations: [] };

    const header = lines[0]!.toLowerCase();
    if (!header.includes('date') || !header.includes('amount')) {
      return { observations: [] };
    }

    const observations: ParsedObservation[] = [];

    for (let i = 1; i < lines.length; i++) {
      const parts = this.parseCsvLine(lines[i]!);
      if (parts.length < 3) continue;

      const dateStr = parts[0];
      const description = parts[1];
      const amountStr = parts[2];
      const accountType = parts[3] || '';

      if (!dateStr || !amountStr) continue;

      const timestamp = this.parseDate(dateStr);
      const amountCents = Math.round(parseFloat(amountStr.replace(/[^0-9.-]/g, '')) * 100);

      let accountHint = 'CPF';
      const accountTypeLower = accountType.toLowerCase();
      if (accountTypeLower.includes('ordinary') || accountTypeLower.includes('(oa)')) {
        accountHint = 'CPF-OA';
      } else if (accountTypeLower.includes('special') || accountTypeLower.includes('(sa)')) {
        accountHint = 'CPF-SA';
      } else if (accountTypeLower.includes('medisave') || accountTypeLower.includes('(ma)')) {
        accountHint = 'CPF-MA';
      }

      observations.push({
        accountHint,
        amountCents,
        currency: 'SGD',
        timestamp,
        merchantText: description || 'CPF Contribution',
        kind: 'deposit',
        adapterName: this.name,
        isStatement: true,
      });
    }

    const byAccount = new Map<string, ParsedObservation[]>();
    for (const observation of observations) {
      const list = byAccount.get(observation.accountHint) ?? [];
      list.push(observation);
      byAccount.set(observation.accountHint, list);
    }

    const statementPeriods: StatementPeriod[] = [];
    for (const [accountHint, accountObs] of byAccount) {
      const timestamps = accountObs.map((item) => item.timestamp);
      const sum = accountObs.reduce((total, item) => total + item.amountCents, 0);
      statementPeriods.push({
        accountHint,
        startDate: Math.min(...timestamps),
        endDate: Math.max(...timestamps),
        openingBalanceCents: 0,
        closingBalanceCents: sum,
      });
    }

    return { observations, statementPeriods };
  }

  private parseCsvLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i]!;

      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }

    result.push(current.trim());
    return result;
  }

  private parseDate(dateStr: string): number {
    const parts = dateStr.split('/');
    if (parts.length !== 3) return 0;

    const day = parseInt(parts[0]!, 10);
    const month = parseInt(parts[1]!, 10) - 1;
    const year = parseInt(parts[2]!, 10);

    return new Date(year, month, day).getTime();
  }
}
