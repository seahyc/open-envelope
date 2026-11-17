import { describe, it, expect } from 'vitest';
import { contextFlag, flagOn } from '../../src/server/lib/context-flags.js';

describe('context flags', () => {
  it('defaults off and accepts 1/true/on/yes', () => {
    expect(contextFlag('location', {})).toBe(false);
    expect(flagOn('CONTEXT_LOCATION', { CONTEXT_LOCATION: '1' })).toBe(true);
    expect(flagOn('CONTEXT_LOCATION', { CONTEXT_LOCATION: 'true' })).toBe(true);
    expect(flagOn('CONTEXT_LOCATION', { CONTEXT_LOCATION: 'ON' })).toBe(true);
    expect(flagOn('CONTEXT_LOCATION', { CONTEXT_LOCATION: 'yes' })).toBe(true);
    expect(flagOn('CONTEXT_LOCATION', { CONTEXT_LOCATION: '0' })).toBe(false);
    expect(flagOn('CONTEXT_CALENDAR', {})).toBe(false);
  });
});
