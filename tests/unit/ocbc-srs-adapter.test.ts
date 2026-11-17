import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { OcbcSrsAdapter } from '../../src/server/adapters/singapore/ocbc-srs-adapter.js';
import { Ocbc360Adapter } from '../../src/server/adapters/singapore/ocbc-360-adapter.js';
import { defaultRegistry } from '../../src/server/adapters/registry.js';

const fixture = join(process.cwd(), 'fixtures/layouts/ocbc-srs.txt');

describe('OcbcSrsAdapter', () => {
  const adapter = new OcbcSrsAdapter();

  it('parses compact day-month rows and flags contribution lines as transfers', async () => {
    const content = readFileSync(fixture);
    expect(await adapter.canParse(content, 'srs.pdf', 'application/pdf')).toBeGreaterThan(0.5);
    expect(await new Ocbc360Adapter().canParse(content, 'srs.pdf', 'application/pdf')).toBe(0);

    const best = await defaultRegistry.findBestAdapter(content, 'ocbc-360.pdf', 'application/pdf');
    expect(best?.adapter.name).toBe('ocbc-srs');

    const result = await adapter.parse(content);
    expect(result.observations).toHaveLength(3);
    expect(result.statementPeriod?.accountHint).toBe('169123456001');
    expect(result.statementPeriod?.openingBalanceCents).toBe(2141666);
    expect(result.statementPeriod?.closingBalanceCents).toBe(2143166);
    expect(result.statementPeriod?.startDate).toBe(new Date(2026, 4, 1).getTime());
    expect(result.statementPeriod?.endDate).toBe(new Date(2026, 4, 31).getTime());

    const contribution = result.observations.find((obs) => obs.reference === 'srs-contribution');
    expect(contribution).toBeDefined();
    expect(contribution?.amountCents).toBe(200000);
    expect(contribution?.kind).toBe('transfer');
    expect(contribution?.timestamp).toBe(new Date(2026, 4, 7).getTime());

    const purchase = result.observations.find((obs) => obs.merchantText.includes('PUR OF'));
    expect(purchase?.amountCents).toBe(-200000);
    expect(purchase?.kind).not.toBe('transfer');
    expect(purchase?.reference).toBeUndefined();
    expect(purchase?.timestamp).toBe(new Date(2026, 4, 15).getTime());

    const dividend = result.observations.find((obs) => obs.merchantText.includes('DIVIDEND'));
    expect(dividend?.amountCents).toBe(1500);
    expect(dividend?.timestamp).toBe(new Date(2026, 4, 20).getTime());

    const sum = result.observations.reduce((total, obs) => total + obs.amountCents, 0);
    expect(2141666 + sum).toBe(2143166);
  });
});
