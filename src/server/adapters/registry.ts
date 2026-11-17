import type { Adapter } from './adapter.js';
import { CsvAdapter } from './csv-adapter.js';
import { OfxAdapter } from './ofx-adapter.js';
import { PdfAdapter } from './pdf-adapter.js';
import { EmailRawAdapter } from './email-raw-adapter.js';
import { OcbcCardAdapter } from './singapore/ocbc-card-adapter.js';
import { Ocbc360Adapter } from './singapore/ocbc-360-adapter.js';
import { OcbcSrsAdapter } from './singapore/ocbc-srs-adapter.js';
import { DbsAccountAdapter } from './singapore/dbs-account-adapter.js';
import { DbsCardAdapter } from './singapore/dbs-card-adapter.js';
import { CpfAdapter } from './singapore/cpf-adapter.js';
import { OcbcAlertAdapter } from './singapore/ocbc-alert-adapter.js';
import { DbsAlertAdapter } from './singapore/dbs-alert-adapter.js';
import { BankAlertAdapter } from './singapore/bank-alert-adapter.js';

export interface AdapterWithConfidence {
  adapter: Adapter;
  confidence: number;
}

export interface ContentDetector {
  canParse(content: Buffer, filename: string, mimeType: string): Promise<number>;
}

export class AdapterRegistry {
  private adapters: (Adapter & Partial<ContentDetector>)[] = [];

  constructor() {
    this.registerDefaults();
  }

  private registerDefaults(): void {
    this.adapters = [
      new OcbcSrsAdapter(),
      new OcbcCardAdapter(),
      new Ocbc360Adapter(),
      new DbsAccountAdapter(),
      new DbsCardAdapter(),
      new CpfAdapter(),
      new OcbcAlertAdapter(),
      new DbsAlertAdapter(),
      new BankAlertAdapter(),
      new EmailRawAdapter(),
      new PdfAdapter('pdf-generic', {
        accountHintRegex: 'Account.*?(\\d{4})',
        transactionRegex: '(\\d{2}\\s+[A-Z]{3})\\s+(.+?)\\s+([\\d,.]+)',
        dateGroup: 1,
        merchantGroup: 2,
        amountGroup: 3,
      }),
      new OfxAdapter(),
      new CsvAdapter({
        accountHint: 'generic',
        dateColumn: 'Date',
        amountColumn: 'Amount',
        merchantColumn: 'Description',
      }),
    ];
  }

  register(adapter: Adapter & Partial<ContentDetector>): void {
    this.adapters.push(adapter);
  }

  getAll(): Adapter[] {
    return this.adapters;
  }

  async findBestAdapter(
    content: Buffer,
    filename: string,
    mimeType: string
  ): Promise<AdapterWithConfidence | null> {
    const candidates: AdapterWithConfidence[] = [];

    for (const adapter of this.adapters) {
      if (adapter.canParse) {
        const confidence = await adapter.canParse(content, filename, mimeType);
        if (confidence > 0) {
          candidates.push({ adapter, confidence });
        }
      } else if (adapter.supportedMimeTypes.includes(mimeType)) {
        candidates.push({ adapter, confidence: 0.5 });
      }
    }

    if (candidates.length === 0) {
      return null;
    }

    candidates.sort((a, b) => b.confidence - a.confidence);
    return candidates[0]!;
  }
}

export const defaultRegistry = new AdapterRegistry();
