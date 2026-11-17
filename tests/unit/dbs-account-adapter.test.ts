import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DbsAccountAdapter } from '../../src/server/adapters/singapore/dbs-account-adapter.js';

describe('DbsAccountAdapter', () => {
  const adapter = new DbsAccountAdapter();

  it('signs deposits and withdrawals from the running balance and uses the header year', async () => {
    const content = readFileSync(join(process.cwd(), 'fixtures/singapore/dbs-account-statement.txt'));
    const result = await adapter.parse(content);
    const observations = result.observations;

    expect(observations).toHaveLength(8);

    const salary = observations.find((obs) => obs.merchantText.includes('SALARY'));
    expect(salary).toBeDefined();
    expect(salary!.amountCents).toBe(500000);
    expect(salary!.timestamp).toBe(new Date(2024, 0, 3).getTime());

    const transfer = observations.find((obs) => obs.merchantText.includes('FAST TRANSFER'));
    expect(transfer!.amountCents).toBe(-50000);

    const paynow = observations.find((obs) => obs.merchantText.includes('PAYNOW'));
    expect(paynow!.amountCents).toBe(10000);

    const interest = observations.find((obs) => obs.merchantText.includes('INTEREST'));
    expect(interest!.amountCents).toBe(782);

    const utilities = observations.find((obs) => obs.merchantText.includes('UTILITIES'));
    expect(utilities!.amountCents).toBe(-14580);
    expect(utilities!.timestamp).toBe(new Date(2024, 0, 28).getTime());

    expect(result.statementPeriod).toBeDefined();
    expect(result.statementPeriod!.startDate).toBe(new Date(2024, 0, 1).getTime());
    expect(result.statementPeriod!.endDate).toBe(new Date(2024, 0, 31).getTime());
    expect(result.statementPeriod!.openingBalanceCents).toBe(345680);
    expect(result.statementPeriod!.closingBalanceCents).toBe(737262);

    const sum = observations.reduce((total, obs) => total + obs.amountCents, 0);
    expect(result.statementPeriod!.openingBalanceCents + sum).toBe(result.statementPeriod!.closingBalanceCents);
  });

  it('uses the eSavings Transaction Details block when a page-1 Account Summary table is also present', async () => {
    const content = readFileSync(join(process.cwd(), 'fixtures/layouts/dbs-posb-active-summary-and-details.txt'));
    const result = await adapter.parse(content);
    expect(result.observations).toHaveLength(2);
    expect(result.statementPeriod?.accountHint).toBe('123456789');
    expect(result.statementPeriod?.openingBalanceCents).toBe(100000);
    expect(result.statementPeriod?.closingBalanceCents).toBe(97000);
    expect(result.observations[0]?.merchantText).toMatch(/FAST Collection/);
    expect(result.observations[0]?.amountCents).toBe(5000);
    expect(result.observations[0]?.timestamp).toBe(new Date(2026, 10, 5).getTime());
    expect(result.observations[1]?.amountCents).toBe(-8000);
    expect(result.observations[1]?.timestamp).toBe(new Date(2026, 10, 12).getTime());
    const sum = result.observations.reduce((total, obs) => total + obs.amountCents, 0);
    expect(100000 + sum).toBe(97000);
  });

  it('parses POSB eSavings only, skips an empty Multiplier section, and uses dd/mm/yyyy', async () => {
    const content = readFileSync(join(process.cwd(), 'fixtures/layouts/dbs-posb-esavings.txt'));
    expect(await adapter.canParse(content, 'posb.pdf', 'application/pdf')).toBeGreaterThan(0.5);
    const result = await adapter.parse(content);
    expect(result.observations).toHaveLength(2);
    expect(result.statementPeriod?.accountHint).toBe('112609016');
    expect(result.statementPeriod?.openingBalanceCents).toBe(36539);
    expect(result.statementPeriod?.closingBalanceCents).toBe(32539);
    expect(result.observations[0]?.merchantText).toMatch(/FAST Collection/);
    expect(result.observations[0]?.amountCents).toBe(2000);
    expect(result.observations[0]?.timestamp).toBe(new Date(2026, 7, 21).getTime());
    expect(result.observations[1]?.amountCents).toBe(-6000);
    expect(result.observations.some((obs) => /Multiplier/i.test(obs.merchantText))).toBe(false);
    const sum = result.observations.reduce((total, obs) => total + obs.amountCents, 0);
    expect(36539 + sum).toBe(32539);
  });

  it('emits a 0-line period from the account-summary SGD balance when there is no eSavings transaction section', async () => {
    const content = readFileSync(join(process.cwd(), 'fixtures/layouts/dbs-posb-quiet-summary.txt'));
    expect(await adapter.canParse(content, 'posb.pdf', 'application/pdf')).toBeGreaterThan(0.5);
    const result = await adapter.parse(content);
    expect(result.observations).toHaveLength(0);
    expect(result.statementPeriod?.openingBalanceCents).toBe(123456);
    expect(result.statementPeriod?.closingBalanceCents).toBe(123456);
    expect(result.statementPeriod?.startDate).toBe(new Date(2026, 9, 1).getTime());
    expect(result.statementPeriod?.endDate).toBe(new Date(2026, 9, 31).getTime());
  });

  it('treats a quiet month with only balances as a valid 0-line statement', async () => {
    const result = await adapter.parse(readFileSync(join(process.cwd(), 'fixtures/layouts/dbs-posb-quiet.txt')));
    expect(result.observations).toHaveLength(0);
    expect(result.statementPeriod?.openingBalanceCents).toBe(32539);
    expect(result.statementPeriod?.closingBalanceCents).toBe(32539);
    expect(result.statementPeriod?.accountHint).toBe('112609016');
    expect(result.statementPeriod?.startDate).toBe(new Date(2026, 8, 1).getTime());
    expect(result.statementPeriod?.endDate).toBe(new Date(2026, 8, 30).getTime());
  });

  it('detects the bank from statement header text, not the filename', async () => {
    const content = readFileSync(join(process.cwd(), 'fixtures/singapore/dbs-account-statement.txt'));
    const score = await adapter.canParse(content, 'ocbc-card-statement.pdf', 'application/pdf');
    expect(score).toBeGreaterThan(0.5);

    const ocbcCard = readFileSync(join(process.cwd(), 'fixtures/singapore/ocbc-card-statement.txt'));
    const wrongScore = await adapter.canParse(ocbcCard, 'dbs-account-statement.txt', 'text/plain');
    expect(wrongScore).toBe(0);
  });
});
