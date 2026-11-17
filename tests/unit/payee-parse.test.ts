import { describe, it, expect } from 'vitest';
import { parsePayeeAndUen } from '../../src/server/services/payee-parse.js';

describe('parsePayeeAndUen', () => {
  it('extracts the truncated PayNow payee and strips OTHR noise', () => {
    const parsed = parsePayeeAndUen(
      'FAST PAYMENT via PayNow-UEN to ABOVE ALL ENTERP OTHR-OTHR'
    );
    expect(parsed.opaque).toBe(true);
    expect(parsed.uen).toBeNull();
    expect(parsed.payeeName).toBe('ABOVE ALL ENTERP');
  });

  it('extracts a UEN when present', () => {
    const parsed = parsePayeeAndUen(
      'FAST PAYMENT via PayNow-UEN 201234567A to CAFE ABC OTHR-OTHR'
    );
    expect(parsed.uen).toBe('201234567A');
    expect(parsed.payeeName).toBe('CAFE ABC');
  });

  it('parses GIRO from-payee lines', () => {
    const parsed = parsePayeeAndUen('GIRO FROM IRAS INCOME TAX');
    expect(parsed.opaque).toBe(true);
    expect(parsed.payeeName).toBe('IRAS INCOME TAX');
  });

  it('treats ATM withdrawals as opaque', () => {
    const parsed = parsePayeeAndUen('ATM WITHDRAWAL 3210');
    expect(parsed.opaque).toBe(true);
    expect(parsed.payeeName).toMatch(/ATM WITHDRAWAL/i);
  });

  it('treats cashier\'s orders as opaque and keeps the payee', () => {
    const parsed = parsePayeeAndUen("CASHIER'S ORDER TO ABC HOUSING PTE LTD");
    expect(parsed.opaque).toBe(true);
    expect(parsed.payeeName).toBe('ABC HOUSING PTE LTD');
  });
});
