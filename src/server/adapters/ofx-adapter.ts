import type { Adapter, ParsedObservation } from './adapter.js';
import type { ObservationKind } from '../../shared/types.js';

export class OfxAdapter implements Adapter {
  readonly name = 'ofx';
  readonly supportedMimeTypes = ['application/x-ofx', 'text/plain'];

  async parse(content: Buffer): Promise<ParsedObservation[]> {
    const text = content.toString('utf-8');
    const observations: ParsedObservation[] = [];

    const accountMatch = text.match(/<ACCTID>([^<]+)/);
    const accountHint = accountMatch ? accountMatch[1]!.trim() : 'unknown';

    const transactionBlocks = text.match(/<STMTTRN>[\s\S]*?<\/STMTTRN>/g) || [];

    for (const block of transactionBlocks) {
      const trnType = this.extractTag(block, 'TRNTYPE');
      const dtPosted = this.extractTag(block, 'DTPOSTED');
      const trnAmt = this.extractTag(block, 'TRNAMT');
      const fitId = this.extractTag(block, 'FITID');
      const name = this.extractTag(block, 'NAME') || this.extractTag(block, 'MEMO') || 'Unknown';

      if (!dtPosted || !trnAmt) continue;

      const timestamp = this.parseOfxDate(dtPosted);
      const amountCents = Math.round(parseFloat(trnAmt) * 100);
      const kind = this.mapTrnType(trnType, amountCents);

      observations.push({
        accountHint,
        amountCents,
        currency: 'USD',
        timestamp,
        merchantText: name.trim(),
        reference: fitId,
        kind,
        adapterName: this.name,
        isStatement: true,
      });
    }

    return observations;
  }

  private extractTag(text: string, tag: string): string {
    const match = text.match(new RegExp(`<${tag}>([^<]+)`));
    return match ? match[1]!.trim() : '';
  }

  private parseOfxDate(dateStr: string): number {
    const cleaned = dateStr.replace(/\[.*\]/, '');
    const year = parseInt(cleaned.substring(0, 4));
    const month = parseInt(cleaned.substring(4, 6)) - 1;
    const day = parseInt(cleaned.substring(6, 8));
    const hour = parseInt(cleaned.substring(8, 10) || '0');
    const minute = parseInt(cleaned.substring(10, 12) || '0');
    const second = parseInt(cleaned.substring(12, 14) || '0');
    
    return new Date(year, month, day, hour, minute, second).getTime();
  }

  private mapTrnType(trnType: string, amountCents: number): ObservationKind {
    const typeMap: Record<string, ObservationKind> = {
      'DEBIT': 'purchase',
      'CREDIT': 'deposit',
      'INT': 'interest',
      'FEE': 'fee',
      'XFER': 'transfer',
      'ATM': 'withdrawal',
      'POS': 'purchase',
    };
    
    if (trnType && typeMap[trnType]) {
      return typeMap[trnType]!;
    }
    
    return amountCents < 0 ? 'purchase' : 'deposit';
  }
}
