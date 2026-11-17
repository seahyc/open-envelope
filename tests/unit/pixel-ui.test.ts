import { describe, it, expect } from 'vitest';
import { barFillCount } from '../../src/client/components/BracketBar';
import { categoryIconName } from '../../src/client/components/PixelIcon';
import { parseSprite, greyPalette } from '../../src/client/pixels';

describe('pixel UI helpers', () => {
  it('fills bracket cells from a ratio', () => {
    expect(barFillCount(0, 12)).toBe(0);
    expect(barFillCount(1, 12)).toBe(12);
    expect(barFillCount(0.5, 12)).toBe(6);
    expect(barFillCount(2, 8)).toBe(8);
  });

  it('maps category labels to coloured icon names', () => {
    expect(categoryIconName('Food ▸ Groceries')).toBe('food');
    expect(categoryIconName('Transport ▸ Ride-hailing')).toBe('transport');
    expect(categoryIconName('Housing ▸ Utilities')).toBe('housing');
    expect(categoryIconName(null)).toBe('star');
  });

  it('greys a palette for inactive tab icons', () => {
    expect(greyPalette({ k: '#111111', g: '#3ddc84' })).toEqual({
      k: '#c8c8c8',
      g: '#c8c8c8',
    });
  });

  it('parses sprite rows into pixels', () => {
    const pixels = parseSprite(['.kg', 'k..'], { k: '#111', g: '#3ddc84' });
    expect(pixels).toEqual([
      [1, 0, '#111'],
      [2, 0, '#3ddc84'],
      [0, 1, '#111'],
    ]);
  });
});
