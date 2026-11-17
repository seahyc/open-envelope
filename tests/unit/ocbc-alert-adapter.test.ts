import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { OcbcAlertAdapter } from '../../src/server/adapters/singapore/ocbc-alert-adapter.js';

describe('OcbcAlertAdapter', () => {
  const adapter = new OcbcAlertAdapter();

  it('parses real OCBC card alert fixture correctly', async () => {
    const fixturePath = join(process.cwd(), 'fixtures/singapore/ocbc-card-alert.eml');
    const content = readFileSync(fixturePath);

    const canParseScore = await adapter.canParse(content, 'ocbc-card-alert.eml', 'message/rfc822');
    expect(canParseScore).toBe(0.95);

    const parseResult = await adapter.parse(content);
    const observations = Array.isArray(parseResult) ? parseResult : parseResult.observations;
    expect(observations).toHaveLength(1);

    const obs = observations[0]!;
    expect(obs.merchantText).toBe('FAIRPRICE FINEST ORCHARD');
    expect(obs.amountCents).toBe(-12550);
    expect(obs.currency).toBe('SGD');
    expect(obs.accountHint).toBe('card-2345');
    expect(obs.kind).toBe('purchase');

    expect(obs.timestamp).toBe(Date.UTC(2024, 0, 15, 6, 30, 0));
    expect(obs.parseMethod).toMatch(/^patterns/);
    expect(obs.parseConfidence).toBeGreaterThan(0.6);
  });

  it('parses OCBC PayNow alerts', async () => {
    const content = readFileSync(join(process.cwd(), 'fixtures/context/ocbc-paynow-alert.eml'));
    expect(await adapter.canParse(content, 'ocbc-paynow-alert.eml', 'message/rfc822')).toBe(0.95);
    const observations = await adapter.parse(content);
    expect(observations).toHaveLength(1);
    const obs = observations[0]!;
    expect(obs.merchantText).toBe('TAN WEI MING');
    expect(obs.amountCents).toBe(-25000);
    expect(obs.accountHint).toBe('acct-3210');
    expect(obs.kind).toBe('transfer');
  });

  it('parses OCBC NETS alerts', async () => {
    const content = readFileSync(join(process.cwd(), 'fixtures/context/ocbc-nets-alert.eml'));
    expect(await adapter.canParse(content, 'ocbc-nets-alert.eml', 'message/rfc822')).toBe(0.95);
    const observations = await adapter.parse(content);
    expect(observations).toHaveLength(1);
    const obs = observations[0]!;
    expect(obs.merchantText).toBe('COLD STORAGE HOLLAND V');
    expect(obs.amountCents).toBe(-1840);
    expect(obs.accountHint).toBe('card-2345');
    expect(obs.kind).toBe('purchase');
  });
});
