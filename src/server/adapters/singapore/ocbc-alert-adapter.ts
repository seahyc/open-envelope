import type { Adapter, ParsedObservation } from '../adapter.js';
import { extractBankAlert, extractionToObservation } from './bank-alert-extract.js';

export class OcbcAlertAdapter implements Adapter {
  readonly name = 'ocbc-alert';
  readonly supportedMimeTypes = ['message/rfc822', 'text/plain'];

  async canParse(content: Buffer, _filename: string, _mimeType: string): Promise<number> {
    const text = content.toString('utf-8');
    const from = text.match(/^From:\s*(.+)$/im)?.[1] || '';
    const subject = text.match(/^Subject:\s*(.+)$/im)?.[1] || '';
    if (from.toLowerCase().includes('ocbc') || subject.toLowerCase().includes('ocbc')) {
      return 0.95;
    }
    return 0;
  }

  async parse(content: Buffer): Promise<ParsedObservation[]> {
    const extracted = extractBankAlert(content.toString('utf-8'));
    const observation = extractionToObservation(extracted, this.name);
    return observation ? [observation] : [];
  }
}
