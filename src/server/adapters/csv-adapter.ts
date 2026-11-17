import type { Adapter, ParsedObservation } from './adapter.js';
import type { ObservationKind } from '../../shared/types.js';

export interface CsvAdapterConfig {
  accountHint: string;
  dateColumn: string;
  amountColumn: string;
  merchantColumn: string;
  referenceColumn?: string;
  dateFormat?: string;
  hasHeader?: boolean;
  delimiter?: string;
}

export class CsvAdapter implements Adapter {
  readonly name = 'csv-generic';
  readonly supportedMimeTypes = ['text/csv', 'text/plain'];

  constructor(private config: CsvAdapterConfig) {}

  async canParse(content: Buffer, filename: string, mimeType: string): Promise<number> {
    if (mimeType !== 'text/csv' && !filename.endsWith('.csv')) {
      return 0;
    }
    
    const text = content.toString('utf-8', 0, Math.min(1000, content.length));
    if (text.includes(',') || text.includes('\t')) {
      return 0.5;
    }
    
    return 0;
  }

  async parse(content: Buffer): Promise<ParsedObservation[]> {
    const text = content.toString('utf-8');
    const lines = text.split('\n').filter(l => l.trim());
    
    const delimiter = this.config.delimiter || ',';
    const hasHeader = this.config.hasHeader !== false;
    
    const rows = lines.map(line => this.parseCsvLine(line, delimiter));
    const dataRows = hasHeader ? rows.slice(1) : rows;
    
    let header: string[] = [];
    if (hasHeader && rows.length > 0) {
      header = rows[0]!;
    } else {
      header = dataRows[0]?.map((_, i) => `col${i}`) || [];
    }

    const observations: ParsedObservation[] = [];

    for (const row of dataRows) {
      if (row.length === 0) continue;
      
      const rowObj: Record<string, string> = {};
      header.forEach((h, i) => {
        rowObj[h] = row[i] || '';
      });

      const dateStr = rowObj[this.config?.dateColumn || 'Date'];
      const amountStr = rowObj[this.config?.amountColumn || 'Amount'];
      const merchant = rowObj[this.config?.merchantColumn || 'Description'];
      const reference = this.config?.referenceColumn ? rowObj[this.config.referenceColumn] : undefined;
      const accountFromRow = rowObj['Account'] || rowObj['account'];

      if (!dateStr || !amountStr || !merchant) continue;

      const timestamp = this.parseDate(dateStr);
      const amountCents = this.parseAmount(amountStr);
      const kind: ObservationKind = amountCents < 0 ? 'purchase' : 'deposit';

      observations.push({
        accountHint: accountFromRow || this.config?.accountHint || '',
        amountCents,
        currency: 'USD',
        timestamp,
        merchantText: merchant.trim(),
        reference: reference?.trim(),
        kind,
        adapterName: this.name,
        isStatement: true,
      });
    }

    return observations;
  }

  private parseCsvLine(line: string, delimiter: string): string[] {
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
      } else if (char === delimiter && !inQuotes) {
        result.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    
    result.push(current);
    return result;
  }

  private parseDate(dateStr: string): number {
    const date = new Date(dateStr);
    return date.getTime();
  }

  private parseAmount(amountStr: string): number {
    const cleaned = amountStr.replace(/[^0-9.-]/g, '');
    const float = parseFloat(cleaned);
    return Math.round(float * 100);
  }
}
