import type { Adapter, ParsedObservation } from '../adapter.js';
import { extractBankAlert, extractionToObservation } from './bank-alert-extract.js';

export class DbsAlertAdapter implements Adapter {
  readonly name = 'dbs-alert';
  readonly supportedMimeTypes = ['message/rfc822', 'text/plain'];

  async canParse(content: Buffer, _filename: string, _mimeType: string): Promise<number> {
    const text = content.toString('utf-8');
    const from = text.match(/^From:\s*(.+)$/im)?.[1] || '';
    const subject = text.match(/^Subject:\s*(.+)$/im)?.[1] || '';
    const blob = `${from}\n${subject}\n${text}`.toLowerCase();
    if (blob.includes('dbs') || blob.includes('posb') || blob.includes('paylah')) {
      if (blob.includes('paylah')) return 0.88;
      return 0.85;
    }
    return 0;
  }

  async parse(content: Buffer): Promise<ParsedObservation[]> {
    const extracted = extractBankAlert(content.toString('utf-8'));
    const observation = extractionToObservation(extracted, this.name);
    return observation ? [observation] : [];
  }
}
