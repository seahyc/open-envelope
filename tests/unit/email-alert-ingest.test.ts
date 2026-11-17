import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { resolveEmailAlert } from '../../src/server/services/email-alert-ingest.js';
import type { LLMProvider } from '../../src/server/lib/llm-provider.js';

function raw(name: string): Buffer {
  return readFileSync(join(process.cwd(), 'fixtures/alerts', name));
}

describe('email alert ingest resolution', () => {
  it('uses patterns when confidence is high', async () => {
    const rawEmail = raw('ocbc-card-alert-new.eml');
    const resolved = await resolveEmailAlert(rawEmail, 'ocbc-new.eml', 'message/rfc822', rawEmail.toString('utf-8'), null);
    expect(resolved.method).toMatch(/^patterns/);
    expect(resolved.observations).toHaveLength(1);
    expect(resolved.observations[0]?.parseConfidence).toBeGreaterThanOrEqual(0.6);
    expect(resolved.observations[0]?.parseMethod).toMatch(/^patterns/);
    expect(resolved.reviewText).toBeNull();
  });

  it('falls back to LLM extractAlertFields and never asks for balances', async () => {
    const text = `From: alerts@unknown.test
Subject: Transaction alert

Card ending 9999 was used. Wording is too odd to parse.
`;
    const extractAlertFields = vi.fn().mockResolvedValue({
      amount: -8.2,
      currency: 'SGD',
      date: '2026-11-02',
      time: '10:15',
      merchant: 'KOPITIAM',
      last4: '9999',
      direction: 'debit',
      kind: 'purchase',
    });
    const llm = { extractAlertFields } as unknown as LLMProvider;
    const resolved = await resolveEmailAlert(Buffer.from(text), 'odd.eml', 'message/rfc822', text, llm);
    expect(extractAlertFields).toHaveBeenCalled();
    expect(resolved.method).toBe('llm');
    expect(resolved.observations[0]?.merchantText).toBe('KOPITIAM');
    expect(resolved.observations[0]?.amountCents).toBe(-820);
    expect(resolved.observations[0]?.parseMethod).toBe('llm');
  });

  it('sends incomplete alerts to review with the email text', async () => {
    const text = `From: alerts@ocbc.com.sg
Subject: Card Transaction Alert

Your OCBC card was used today. Please check the app.
`;
    const resolved = await resolveEmailAlert(Buffer.from(text), 'incomplete.eml', 'message/rfc822', text, null);
    expect(resolved.method).toBe('unparsed');
    expect(resolved.observations).toHaveLength(0);
    expect(resolved.reviewText).toContain('Please check the app');
  });
});
