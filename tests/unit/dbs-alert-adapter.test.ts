import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DbsAlertAdapter } from '../../src/server/adapters/singapore/dbs-alert-adapter.js';

describe('DbsAlertAdapter', () => {
  const adapter = new DbsAlertAdapter();

  it('parses DBS card alert fixture correctly', async () => {
    const fixturePath = join(process.cwd(), 'fixtures/singapore/dbs-alert.eml');
    const content = readFileSync(fixturePath);

    const canParseScore = await adapter.canParse(content, 'dbs-alert.eml', 'message/rfc822');
    expect(canParseScore).toBe(0.85);

    const observations = await adapter.parse(content);
    expect(observations).toHaveLength(1);

    const obs = observations[0]!;
    expect(obs.merchantText).toBe('FAIRPRICE FINEST');
    expect(obs.amountCents).toBe(-7890);
    expect(obs.currency).toBe('SGD');
    expect(obs.accountHint).toBe('card-6789');
    expect(obs.kind).toBe('purchase');

    expect(obs.timestamp).toBe(Date.UTC(2024, 0, 5, 1, 15, 0));
    expect(obs.parseMethod).toMatch(/^patterns/);
  });

  it('parses PayLah alert fixture correctly', async () => {
    const fixturePath = join(process.cwd(), 'fixtures/singapore/paylah-alert.eml');
    const content = readFileSync(fixturePath);

    const canParseScore = await adapter.canParse(content, 'paylah-alert.eml', 'message/rfc822');
    expect(canParseScore).toBe(0.88);

    const observations = await adapter.parse(content);
    expect(observations).toHaveLength(1);

    const obs = observations[0]!;
    expect(obs.merchantText).toBe('PayLah from Sam');
    expect(obs.amountCents).toBe(5000);
    expect(obs.currency).toBe('SGD');
    expect(obs.accountHint).toBe('paylah');
    expect(obs.kind).toBe('deposit');

    const expectedDate = new Date('Wed, 17 Jan 2024 16:45:00 +0800');
    expect(obs.timestamp).toBe(expectedDate.getTime());
  });
});
