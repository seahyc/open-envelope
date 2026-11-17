import type { Adapter, ParsedObservation } from '../adapter.js';
import { extractBankAlert, extractionToObservation } from './bank-alert-extract.js';

export class BankAlertAdapter implements Adapter {
  readonly name = 'bank-alert';
  readonly supportedMimeTypes = ['message/rfc822', 'text/plain'];

  async canParse(content: Buffer, _filename: string, _mimeType: string): Promise<number> {
    const text = content.toString('utf-8');
    if (/opening balance|closing balance|statement period|statement of account/i.test(text)) return 0;
    const extracted = extractBankAlert(text);
    if (!extracted.looksLikeAlert || extracted.confidence < 0.4) return 0;
    return extracted.confidence;
  }

  async parse(content: Buffer): Promise<ParsedObservation[]> {
    const extracted = extractBankAlert(content.toString('utf-8'));
    const observation = extractionToObservation(extracted, this.name);
    return observation ? [observation] : [];
  }
}
