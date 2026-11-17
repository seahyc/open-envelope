import type { Adapter, ParsedObservation } from './adapter.js';
import { extractStatementText } from '../lib/pdf-text-extractor.js';

export interface PdfStatementParser {
  accountHintRegex: string;
  transactionRegex: string;
  dateGroup: number;
  merchantGroup: number;
  amountGroup: number;
}

export class PdfAdapter implements Adapter {
  readonly name: string;
  readonly supportedMimeTypes = ['application/pdf'];

  constructor(
    name: string,
    private parser: PdfStatementParser
  ) {
    this.name = `pdf-${name}`;
  }

  async canParse(content: Buffer, _filename: string, mimeType: string): Promise<number> {
    if (mimeType !== 'application/pdf') {
      return 0;
    }

    if (content.slice(0, 4).toString() !== '%PDF') {
      return 0;
    }

    return 0.2;
  }

  async parse(content: Buffer): Promise<ParsedObservation[]> {
    const text = await this.extractText(content);
    
    const accountMatch = text.match(new RegExp(this.parser.accountHintRegex, 'i'));
    const accountHint = accountMatch ? accountMatch[1]!.trim() : 'unknown';

    const observations: ParsedObservation[] = [];
    const transactionRegex = new RegExp(this.parser.transactionRegex, 'gi');
    
    let match;
    while ((match = transactionRegex.exec(text)) !== null) {
      const dateStr = match[this.parser.dateGroup];
      const merchant = match[this.parser.merchantGroup];
      const amountStr = match[this.parser.amountGroup];

      if (!dateStr || !merchant || !amountStr) continue;

      const timestamp = new Date(dateStr).getTime();
      const amountCents = this.parseAmount(amountStr);

      observations.push({
        accountHint,
        amountCents,
        currency: 'USD',
        timestamp,
        merchantText: merchant.trim(),
        kind: amountCents < 0 ? 'purchase' : 'deposit',
        adapterName: this.name,
        isStatement: true,
      });
    }

    return observations;
  }

  private async extractText(content: Buffer): Promise<string> {
    return extractStatementText(content);
  }

  private parseAmount(amountStr: string): number {
    const cleaned = amountStr.replace(/[^0-9.-]/g, '');
    const float = parseFloat(cleaned);
    return Math.round(float * 100);
  }
}
