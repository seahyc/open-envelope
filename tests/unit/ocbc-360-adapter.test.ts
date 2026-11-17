import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Ocbc360Adapter } from '../../src/server/adapters/singapore/ocbc-360-adapter.js';

const layouts = join(process.cwd(), 'fixtures/layouts');
const singapore = join(process.cwd(), 'fixtures/singapore');

describe('Ocbc360Adapter', () => {
  const adapter = new Ocbc360Adapter();

  it('parses the legacy fixture with header year and opening/closing SGD balances', async () => {
    const result = await adapter.parse(readFileSync(join(singapore, 'ocbc-360-statement.txt')));
    expect(result.observations).toHaveLength(7);
    expect(result.statementPeriod?.openingBalanceCents).toBe(523450);
    expect(result.statementPeriod?.closingBalanceCents).toBe(869670);
    const sum = result.observations.reduce((total, obs) => total + obs.amountCents, 0);
    expect(result.statementPeriod!.openingBalanceCents + sum).toBe(result.statementPeriod!.closingBalanceCents);
  });

  it('parses the real 360 layout: two dates, continuation lines, page wrap, running balance, and year from period', async () => {
    const content = readFileSync(join(layouts, 'ocbc-360-bank-account.txt'));
    expect(await adapter.canParse(content, 'stmt.pdf', 'application/pdf')).toBeGreaterThan(0.5);

    const result = await adapter.parse(content);
    expect(result.observations).toHaveLength(6);
    expect(result.statementPeriod?.accountHint).toBe('501234567001');
    expect(result.statementPeriod?.openingBalanceCents).toBe(123456);
    expect(result.statementPeriod?.closingBalanceCents).toBe(485231);
    expect(result.statementPeriod?.startDate).toBe(new Date(2026, 7, 1).getTime());
    expect(result.statementPeriod?.endDate).toBe(new Date(2026, 7, 31).getTime());

    const fast = result.observations.find((obs) => obs.merchantText.includes('FAST PAYMENT'));
    expect(fast?.amountCents).toBe(-4000);
    expect(fast?.timestamp).toBe(new Date(2026, 7, 2).getTime());
    expect(fast?.merchantText).toMatch(/via PayNow-Mobile/);
    expect(fast?.merchantText).toMatch(/JAMIE LIM/);
    expect(fast?.merchantText).toMatch(/OTHR-REF8891/);

    const salary = result.observations.find((obs) => obs.merchantText.includes('SALARY'));
    expect(salary?.amountCents).toBe(350000);
    expect(salary?.timestamp).toBe(new Date(2026, 7, 5).getTime());

    const fairprice = result.observations.find((obs) => obs.merchantText.includes('NTUC FAIRPRICE'));
    expect(fairprice?.amountCents).toBe(-5620);
    expect(fairprice?.merchantText).toMatch(/TAMPINES/);

    const interest = result.observations.find((obs) => obs.merchantText.includes('INTEREST'));
    expect(interest?.amountCents).toBe(125);
    expect(interest?.kind).toBe('interest');

    const cashDeposit = result.observations.find((obs) => obs.merchantText.includes('CASH DEPOSIT'));
    expect(cashDeposit?.amountCents).toBe(30000);
    expect(cashDeposit?.merchantText).toMatch(/CDM/);

    const sum = result.observations.reduce((total, obs) => total + obs.amountCents, 0);
    expect(result.statementPeriod!.openingBalanceCents + sum).toBe(result.statementPeriod!.closingBalanceCents);
  });

  it('routes a 360 statement with Supplementary Retirement footer text to ocbc-360, not ocbc-srs', async () => {
    const { defaultRegistry } = await import('../../src/server/adapters/registry.js');
    const { OcbcSrsAdapter } = await import('../../src/server/adapters/singapore/ocbc-srs-adapter.js');
    const content = readFileSync(join(layouts, 'ocbc-360-bank-account.txt'));
    expect(await new OcbcSrsAdapter().canParse(content, 'stmt.pdf', 'application/pdf')).toBe(0);
    const best = await defaultRegistry.findBestAdapter(content, 'stmt.pdf', 'application/pdf');
    expect(best?.adapter.name).toBe('ocbc-360');
  });

  it('parses OCBC Statement Savings with the same bank-account layout', async () => {
    const content = readFileSync(join(layouts, 'ocbc-statement-savings.txt'));
    expect(await adapter.canParse(content, 'savings.pdf', 'application/pdf')).toBeGreaterThan(0.5);
    const result = await adapter.parse(content);
    expect(result.observations).toHaveLength(2);
    expect(result.statementPeriod?.accountHint).toBe('550765432008');
    expect(result.statementPeriod?.openingBalanceCents).toBe(80000);
    expect(result.statementPeriod?.closingBalanceCents).toBe(68040);
    expect(result.observations[0]?.amountCents).toBe(-12000);
    expect(result.observations[1]?.amountCents).toBe(40);
    const sum = result.observations.reduce((total, obs) => total + obs.amountCents, 0);
    expect(80000 + sum).toBe(68040);
  });

  it('assigns the correct year on a Dec→Jan statement period', async () => {
    const result = await adapter.parse(readFileSync(join(layouts, 'ocbc-360-dec-jan.txt')));
    expect(result.observations).toHaveLength(2);
    expect(result.observations[0]?.timestamp).toBe(new Date(2025, 11, 28).getTime());
    expect(result.observations[1]?.timestamp).toBe(new Date(2026, 0, 5).getTime());
    expect(result.statementPeriod?.openingBalanceCents).toBe(100000);
    expect(result.statementPeriod?.closingBalanceCents).toBe(140000);
    const sum = result.observations.reduce((total, obs) => total + obs.amountCents, 0);
    expect(100000 + sum).toBe(140000);
  });
});
