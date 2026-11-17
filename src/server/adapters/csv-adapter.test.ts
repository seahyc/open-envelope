import { describe, it, expect } from 'vitest';
import { CsvAdapter } from './csv-adapter';

describe('CsvAdapter', () => {
  it('should parse CSV with header', async () => {
    const adapter = new CsvAdapter({
      accountHint: '1234',
      dateColumn: 'Date',
      amountColumn: 'Amount',
      merchantColumn: 'Description',
      hasHeader: true,
    });

    const csv = `Date,Amount,Description
2024-01-15,-52.13,Whole Foods Market
2024-01-16,-12.50,Coffee Shop
2024-01-17,2500.00,Salary Deposit`;

    const buffer = Buffer.from(csv);
    const observations = await adapter.parse(buffer);

    expect(observations).toHaveLength(3);
    expect(observations[0]).toMatchObject({
      accountHint: '1234',
      amountCents: -5213,
      currency: 'USD',
      merchantText: 'Whole Foods Market',
      kind: 'purchase',
    });
    expect(observations[2]).toMatchObject({
      amountCents: 250000,
      kind: 'deposit',
    });
  });

  it('should handle quoted fields with commas', async () => {
    const adapter = new CsvAdapter({
      accountHint: '5678',
      dateColumn: 'Date',
      amountColumn: 'Amount',
      merchantColumn: 'Description',
    });

    const csv = `Date,Amount,Description
2024-01-15,-25.00,"Restaurant, Downtown"
2024-01-16,-100.00,"Smith, John - Invoice"`;

    const buffer = Buffer.from(csv);
    const observations = await adapter.parse(buffer);

    expect(observations).toHaveLength(2);
    expect(observations[0]?.merchantText).toBe('Restaurant, Downtown');
    expect(observations[1]?.merchantText).toBe('Smith, John - Invoice');
  });

  it('should be idempotent on duplicate imports', async () => {
    const adapter = new CsvAdapter({
      accountHint: '1234',
      dateColumn: 'Date',
      amountColumn: 'Amount',
      merchantColumn: 'Description',
    });

    const csv = `Date,Amount,Description
2024-01-15,-52.13,Whole Foods Market`;

    const buffer = Buffer.from(csv);

    const obs1 = await adapter.parse(buffer);
    const obs2 = await adapter.parse(buffer);

    expect(obs1[0]).toEqual(obs2[0]);
  });
});
