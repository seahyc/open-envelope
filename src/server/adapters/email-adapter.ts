import type { Adapter, ParsedObservation } from './adapter.js';
import type { ObservationKind } from '../../shared/types.js';

export interface EmailAlertRule {
  name: string;
  fromPattern: string;
  subjectPattern: string;
  accountHintRegex: string;
  amountRegex: string;
  merchantRegex: string;
  dateRegex?: string;
  kind?: ObservationKind;
}

export class EmailAdapter implements Adapter {
  readonly name: string;
  readonly supportedMimeTypes = ['message/rfc822', 'text/plain'];

  constructor(
    private rule: EmailAlertRule
  ) {
    this.name = `email-${rule.name}`;
  }

  async parse(content: Buffer): Promise<ParsedObservation[]> {
    const text = content.toString('utf-8');
    
    const fromMatch = text.match(/From: (.+)/i);
    const subjectMatch = text.match(/Subject: (.+)/i);
    
    const from = fromMatch ? fromMatch[1]!.trim() : '';
    const subject = subjectMatch ? subjectMatch[1]!.trim() : '';

    if (!new RegExp(this.rule.fromPattern, 'i').test(from)) {
      return [];
    }
    
    if (!new RegExp(this.rule.subjectPattern, 'i').test(subject)) {
      return [];
    }

    const bodyMatch = text.match(/\r?\n\r?\n([\s\S]+)/);
    const body = bodyMatch ? bodyMatch[1]!.trim() : text;

    const accountMatch = body.match(new RegExp(this.rule.accountHintRegex, 'i'));
    const amountMatch = body.match(new RegExp(this.rule.amountRegex, 'i'));
    const merchantMatch = body.match(new RegExp(this.rule.merchantRegex, 'i'));

    if (!accountMatch || !amountMatch || !merchantMatch) {
      return [];
    }

    const accountHint = accountMatch[1]!.trim();
    const amountStr = amountMatch[1]!.trim();
    const merchant = merchantMatch[1]!.trim();

    const amountCents = -Math.abs(this.parseAmount(amountStr));
    const timestamp = this.parseDate(body);
    const kind = this.rule.kind || 'purchase';

    return [{
      accountHint,
      amountCents,
      currency: 'USD',
      timestamp,
      merchantText: merchant,
      kind,
      adapterName: this.name,
    }];
  }

  private parseAmount(amountStr: string): number {
    const cleaned = amountStr.replace(/[^0-9.-]/g, '');
    const float = parseFloat(cleaned);
    return Math.round(float * 100);
  }

  private parseDate(body: string): number {
    if (this.rule.dateRegex) {
      const dateMatch = body.match(new RegExp(this.rule.dateRegex, 'i'));
      if (dateMatch) {
        return new Date(dateMatch[1]!).getTime();
      }
    }
    return Date.now();
  }
}
