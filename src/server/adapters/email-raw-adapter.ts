import type { Adapter, ParsedObservation } from './adapter.js';
import { logger } from '../lib/logger.js';

export class EmailRawAdapter implements Adapter {
  readonly name = 'email-raw';
  readonly supportedMimeTypes = ['message/rfc822'];

  async canParse(content: Buffer, _filename: string, mimeType: string): Promise<number> {
    if (mimeType !== 'message/rfc822') {
      return 0;
    }

    const text = content.toString('utf-8');
    
    if (!text.match(/^(From|Message-ID|Subject):/im)) {
      return 0;
    }

    return 0.3;
  }

  async parse(content: Buffer, documentHash: string): Promise<ParsedObservation[]> {
    const text = content.toString('utf-8');
    
    const messageId = this.extractHeader(text, 'Message-ID');
    const from = this.extractHeader(text, 'From');
    const subject = this.extractHeader(text, 'Subject');

    logger.info('Parsing raw email', {
      documentHash,
      messageId,
      from: from?.substring(0, 50),
      subject: subject?.substring(0, 100),
    });

    const body = this.extractBody(text);
    
    const observations = this.parseTransactionPatterns(body, documentHash);

    return observations;
  }

  private extractHeader(text: string, headerName: string): string | null {
    const regex = new RegExp(`^${headerName}:\\s*(.+)$`, 'im');
    const match = text.match(regex);
    return match ? match[1]!.trim() : null;
  }

  private extractBody(text: string): string {
    const parts = text.split(/\r?\n\r?\n/);
    if (parts.length < 2) {
      return text;
    }
    
    return parts.slice(1).join('\n\n');
  }

  private parseTransactionPatterns(body: string, documentHash: string): ParsedObservation[] {
    const observations: ParsedObservation[] = [];

    const patterns = [
      {
        regex: /(?:transaction|purchase|debit|credit).*?\$?([\d,]+\.\d{2}).*?at\s+([A-Za-z0-9\s&'-]+)/gi,
        kind: 'purchase' as const,
      },
      {
        regex: /([A-Za-z0-9\s&'-]+).*?\$?([\d,]+\.\d{2})/gi,
        kind: 'purchase' as const,
      },
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.regex.exec(body)) !== null) {
        const amountStr = match[1] || match[2];
        const merchant = match[2] || match[1];
        
        if (!amountStr || !merchant) continue;

        const amount = parseFloat(amountStr.replace(/,/g, ''));
        if (isNaN(amount) || amount === 0) continue;

        observations.push({
          accountHint: '',
          timestamp: Date.now(),
          amountCents: Math.round(-amount * 100),
          currency: 'USD',
          merchantText: merchant.trim(),
          reference: `email_${documentHash.substring(0, 8)}`,
          kind: pattern.kind,
          adapterName: this.name,
        });
      }
    }

    return observations;
  }
}
