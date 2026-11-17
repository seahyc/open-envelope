import { describe, it, expect } from 'vitest';
import { EmailAdapter } from './email-adapter';

describe('EmailAdapter', () => {
  it('should parse transaction alert email', async () => {
    const adapter = new EmailAdapter({
      name: 'sample-bank',
      fromPattern: 'alerts@samplebank.example',
      subjectPattern: 'Card Alert',
      accountHintRegex: 'Card ending in (\\d{4})',
      amountRegex: '\\$([\\d,.]+)',
      merchantRegex: 'at ([A-Za-z0-9 ]+)',
    });

    const email = `From: alerts@samplebank.example
To: alex@example.com
Subject: Card Alert - Purchase Made
Date: Mon, 15 Jan 2024 14:30:00 -0800

Hello Alex,

A purchase was made with your Card ending in 1111 for $87.45 at Generic Grocery Store on 01/15/2024.

If you did not make this purchase, please contact us immediately.

Thank you,
Sample Bank`;

    const buffer = Buffer.from(email);
    const observations = await adapter.parse(buffer);

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      accountHint: '1111',
      amountCents: -8745,
      currency: 'USD',
      kind: 'purchase',
    });
    expect(observations[0]?.merchantText).toContain('Generic Grocery Store');
  });

  it('should skip non-matching emails', async () => {
    const adapter = new EmailAdapter({
      name: 'sample-bank',
      fromPattern: 'alerts@samplebank.example',
      subjectPattern: 'Card Alert',
      accountHintRegex: 'Card ending in (\\d{4})',
      amountRegex: '\\$([\\d,.]+)',
      merchantRegex: 'at ([A-Za-z0-9 ]+)',
    });

    const email = `From: marketing@samplebank.example
Subject: Special Offer

Check out our new credit card!`;

    const buffer = Buffer.from(email);
    const observations = await adapter.parse(buffer);

    expect(observations).toHaveLength(0);
  });
});
