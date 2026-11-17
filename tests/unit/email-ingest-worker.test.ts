import { describe, it, expect } from 'vitest';
import { extractEmailAddress, firstRecipient } from '../../workers/email-ingest/src/index.ts';

function headers(map: Record<string, string>) {
  return {
    get(name: string) {
      return map[name.toLowerCase()] ?? null;
    },
  };
}

describe('email ingest worker recipient', () => {
  it('uses the envelope recipient when Gmail keeps the original To', () => {
    const recipient = firstRecipient({
      to: 'alex-ab12cd34ef56aa77@ingest.example.com',
      headers: headers({
        to: 'Alex <alex@example.com>',
        'delivered-to': 'alex@example.com',
      }),
    });
    expect(recipient).toBe('alex-ab12cd34ef56aa77@ingest.example.com');
  });

  it('falls back to headers only when the envelope is empty', () => {
    const recipient = firstRecipient({
      to: '',
      headers: headers({
        'delivered-to': 'Sam <sam-aa11bb22cc33dd44@ingest.example.test>',
      }),
    });
    expect(recipient).toBe('sam-aa11bb22cc33dd44@ingest.example.test');
  });

  it('strips display names from envelope addresses', () => {
    expect(extractEmailAddress('OpenEnvelope <oe@ingest.example.test>')).toBe('oe@ingest.example.test');
  });
});
