import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DbsCardAdapter } from '../../src/server/adapters/singapore/dbs-card-adapter.js';

const layouts = join(process.cwd(), 'fixtures/layouts');
const singapore = join(process.cwd(), 'fixtures/singapore');

describe('DbsCardAdapter', () => {
  const adapter = new DbsCardAdapter();

  it('still parses the legacy two-date SGD fixture', async () => {
    const result = await adapter.parse(readFileSync(join(singapore, 'dbs-card-statement.txt')));
    expect(result.observations).toHaveLength(8);
    expect(result.statementPeriod?.accountHint).toBe('card-6789');
    const payment = result.observations.find((obs) => obs.merchantText.includes('PAYMENT'));
    expect(payment?.amountCents).toBe(50000);
  });

  it('parses Altitude rows, CARD NO last 4, statement date on the next line, and REF NO wrap', async () => {
    const content = readFileSync(join(layouts, 'dbs-card-altitude.txt'));
    expect(await adapter.canParse(content, 'card.pdf', 'application/pdf')).toBeGreaterThan(0.5);

    const result = await adapter.parse(content);
    expect(result.observations).toHaveLength(3);
    expect(result.statementPeriod?.accountHint).toBe('card-4455');
    expect(result.statementPeriod?.openingBalanceCents).toBe(-5000);
    expect(result.statementPeriod?.closingBalanceCents).toBe(-5540);
    expect(result.statementPeriod?.endDate).toBe(new Date(2026, 2, 20).getTime());

    expect(result.observations[0]?.merchantText).toBe('ANNUAL FEE');
    expect(result.observations[0]?.amountCents).toBe(-18000);
    expect(result.observations[0]?.timestamp).toBe(new Date(2026, 2, 20).getTime());

    const fairprice = result.observations.find((obs) => obs.merchantText.includes('NTUC FAIRPRICE'));
    expect(fairprice?.amountCents).toBe(-2540);
    expect(fairprice?.merchantText).toMatch(/REF NO: 8899001122/);

    const payment = result.observations.find((obs) => obs.merchantText.includes('PAYMENT'));
    expect(payment?.amountCents).toBe(20000);

    expect(result.observations.some((obs) => obs.amountCents === -5000 && obs.merchantText.includes('N.A.'))).toBe(false);
    expect(result.observations.some((obs) => /10,000|CREDIT LIMIT|N\.A\./i.test(obs.merchantText))).toBe(false);
    expect(result.observations.some((obs) => obs.timestamp === new Date(2026, 6, 23).getTime())).toBe(false);

    const sum = result.observations.reduce((total, obs) => total + obs.amountCents, 0);
    expect(-5000 + sum).toBe(-5540);
  });

  it('records a 0-line credit-balance statement from PREVIOUS BALANCE / TOTAL CR', async () => {
    const result = await adapter.parse(readFileSync(join(layouts, 'dbs-card-credit-zero.txt')));
    expect(result.observations).toHaveLength(0);
    expect(result.statementPeriod?.openingBalanceCents).toBe(19620);
    expect(result.statementPeriod?.closingBalanceCents).toBe(19620);
    expect(result.statementPeriod?.accountHint).toBe('card-4455');
  });
});
