import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { BankAlertAdapter } from '../../src/server/adapters/singapore/bank-alert-adapter.js';
import { defaultRegistry } from '../../src/server/adapters/registry.js';
import { extractBankAlert, singaporeWallTimeToUtcMs } from '../../src/server/adapters/singapore/bank-alert-extract.js';

function fixture(dir: 'singapore' | 'alerts', name: string): string {
  return readFileSync(join(process.cwd(), 'fixtures', dir, name), 'utf-8');
}

describe('bank-agnostic alert extraction', () => {
  const adapter = new BankAlertAdapter();

  it('parses the old OCBC card layout', () => {
    const extracted = extractBankAlert(fixture('singapore', 'ocbc-card-alert.eml'));
    expect(extracted.complete).toBe(true);
    expect(extracted.amountCents).toBe(-12550);
    expect(extracted.currency).toBe('SGD');
    expect(extracted.accountHint).toBe('card-2345');
    expect(extracted.merchantText).toBe('FAIRPRICE FINEST ORCHARD');
    expect(extracted.kind).toBe('purchase');
    expect(extracted.hintId).toBe('ocbc');
    expect(extracted.method).toBe('patterns+hint');
    expect(extracted.timestamp).toBe(singaporeWallTimeToUtcMs(2024, 0, 15, 14, 30));
    expect(extracted.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it('parses the reworded OCBC notify.ocbc.com layout', () => {
    const extracted = extractBankAlert(fixture('alerts', 'ocbc-card-alert-new.eml'));
    expect(extracted.complete).toBe(true);
    expect(extracted.amountCents).toBe(-1234);
    expect(extracted.accountHint).toBe('card-1234');
    expect(extracted.merchantText).toBe('FAIRPRICE FINEST ORCHARD');
    expect(extracted.timestamp).toBe(singaporeWallTimeToUtcMs(2026, 10, 3, 14, 5));
  });

  it('parses a UOB-style alert from domain hint only', async () => {
    const content = readFileSync(join(process.cwd(), 'fixtures/alerts/uob-alert.eml'));
    const extracted = extractBankAlert(content.toString('utf-8'));
    expect(extracted.hintId).toBe('uob');
    expect(extracted.amountCents).toBe(-4500);
    expect(extracted.accountHint).toBe('card-8899');
    expect(extracted.merchantText).toBe('GUARDIAN');
    const best = await defaultRegistry.findBestAdapter(content, 'uob-alert.eml', 'message/rfc822');
    expect(best?.adapter.name).toBe('bank-alert');
    const parsed = await adapter.parse(content);
    expect(parsed).toHaveLength(1);
  });

  it('parses a refund as a credit', () => {
    const extracted = extractBankAlert(fixture('alerts', 'ocbc-refund-alert.eml'));
    expect(extracted.amountCents).toBe(1234);
    expect(extracted.kind).toBe('refund');
    expect(extracted.merchantText).toContain('GRAB');
  });

  it('keeps foreign currency', () => {
    const extracted = extractBankAlert(fixture('alerts', 'dbs-fx-alert.eml'));
    expect(extracted.currency).toBe('USD');
    expect(extracted.amountCents).toBe(-1890);
    expect(extracted.merchantText).toBe('AMAZON WEB SERVICES');
  });

  it('accepts dotted dates and 12-hour time', () => {
    const extracted = extractBankAlert(fixture('alerts', 'uob-odd-date-alert.eml'));
    expect(extracted.complete).toBe(true);
    expect(extracted.currency).toBe('USD');
    expect(extracted.amountCents).toBe(-950);
    expect(extracted.accountHint).toBe('card-4410');
    expect(extracted.timestamp).toBe(singaporeWallTimeToUtcMs(2026, 10, 6, 15, 7));
  });

  it('parses an unknown bank with no hint config', async () => {
    const content = readFileSync(join(process.cwd(), 'fixtures/alerts/pacific-alert.eml'));
    const extracted = extractBankAlert(content.toString('utf-8'));
    expect(extracted.hintId).toBeNull();
    expect(extracted.method).toBe('patterns');
    expect(extracted.complete).toBe(true);
    expect(extracted.amountCents).toBe(-680);
    expect(extracted.accountHint).toBe('acct-7721');
    expect(extracted.merchantText).toBe('COLD STORAGE');
    const best = await defaultRegistry.findBestAdapter(content, 'pacific-alert.eml', 'message/rfc822');
    expect(best?.adapter.name).toBe('bank-alert');
  });

  it('skips PayLah balance and keeps the received amount', () => {
    const extracted = extractBankAlert(
      readFileSync(join(process.cwd(), 'fixtures/singapore/paylah-alert.eml'), 'utf-8'),
    );
    expect(extracted.amountCents).toBe(5000);
    expect(extracted.accountHint).toBe('paylah');
    expect(extracted.merchantText).toBe('PayLah from Sam');
    expect(extracted.kind).toBe('deposit');
    expect(extracted.timestamp).toBe(new Date('Wed, 17 Jan 2024 16:45:00 +0800').getTime());
  });
});
