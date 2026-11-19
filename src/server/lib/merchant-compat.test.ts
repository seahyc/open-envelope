import { describe, it, expect } from 'vitest';
import { merchantsCompatible } from './merchant-compat';

describe('merchantsCompatible', () => {
  it('ignores a leading card fragment and statement truncation', () => {
    expect(merchantsCompatible('COLD STORAGE - NOVENA SQUARE', '-1234 COLD STORAGE - N')).toBe(true);
    expect(merchantsCompatible("D LIFE SIGNATURE SINGAPORE", "-1234 D'LIFE SIGNATURE")).toBe(true);
    expect(merchantsCompatible('COLD STORAGE - NOVENA Sin', '-9839 COLD STORAGE - NO SINGAPORE SGP')).toBe(true);
  });

  it('matches identical and containing strings', () => {
    expect(merchantsCompatible('GUARDIAN NOVENA SQUARE', 'GUARDIAN NOVENA SQUARE')).toBe(true);
    expect(merchantsCompatible('SHOPEE SG MP', 'XX SHOPEE SG MP SINGAPORE')).toBe(true);
  });

  it('rejects unrelated or too-short merchants', () => {
    expect(merchantsCompatible('COLD STORAGE', 'GUARDIAN NOVENA')).toBe(false);
    expect(merchantsCompatible('OCBC', 'KAILE PTE LTD')).toBe(false);
    expect(merchantsCompatible('GRABFOOD', 'GRABTAXI')).toBe(false);
    expect(merchantsCompatible('', 'ANYTHING')).toBe(false);
  });
});
