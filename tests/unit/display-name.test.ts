import { describe, it, expect } from 'vitest';
import {
  cleanedPayeeDisplay,
  displayMerchantName,
  friendlyRegisteredName,
} from '../../src/server/services/display-name.js';

const PAYNOW = 'FAST PAYMENT via PayNow-UEN to ABOVE ALL ENTERP OTHR-OTHR';

describe('display names', () => {
  it('prefers saved payee, then enriched friendly name, then a cleaned title-case payee', () => {
    expect(displayMerchantName({
      savedPayee: 'Renovation contractor',
      registeredName: 'ABOVE ALL ENTERPRISE PTE. LTD.',
      merchantText: PAYNOW,
    })).toBe('Renovation contractor');
    expect(displayMerchantName({
      savedPayee: null,
      registeredName: 'ABOVE ALL ENTERPRISE PTE. LTD.',
      merchantText: PAYNOW,
    })).toBe('Above All Enterprise');
    expect(displayMerchantName({
      savedPayee: null,
      registeredName: null,
      merchantText: PAYNOW,
    })).toBe('Above All Enterp');
    expect(cleanedPayeeDisplay(PAYNOW)).not.toMatch(/PAYNOW|FAST|OTHR/i);
    expect(friendlyRegisteredName('ABOVE ALL ENTERPRISE PTE. LTD.')).toBe('Above All Enterprise');
  });
});
