import { type Palette } from '../pixels';
import { PENNY_HAPPY_PALETTE, PENNY_HAPPY_ROWS, PENNY_SIZE } from '../penny-sprite';
import { PixelGrid } from './PixelGrid';

export type PennyMood = 'fed' | 'hungry' | 'stuffed' | 'torn' | 'busy' | 'squinting' | 'asleep';

const SIZE = PENNY_SIZE;

const HAPPY: Palette = PENNY_HAPPY_PALETTE;

const WORRIED: Palette = {
  ...HAPPY,
  c: '#ffe9b8',
  d: '#e8c36a',
  t: '#7ec8ff',
};

const OVER: Palette = {
  k: '#111111',
  c: '#ff8a7a',
  d: '#e24b4a',
  b: '#ffd36a',
  w: '#ffffff',
  t: '#7ec8ff',
};

const SPRITES: Record<PennyMood, { palette: Palette; rows: string[] }> = {
  fed: {
    palette: HAPPY,
    rows: PENNY_HAPPY_ROWS,
  },
  hungry: {
    palette: HAPPY,
    rows: [
      '................',
      '......kkkk......',
      '....kkddddkk....',
      '...kddddddddk...',
      '..kddddddddddk..',
      '..kkkkkkkkkkkk..',
      '..kcccccccccck..',
      '..kcwkccccwkck..',
      '..kcccccccccck..',
      '..kcc......cck..',
      '..kcccccccccck..',
      '..kkkkkkkkkkkk..',
      '...k......k.....',
      '...kk....kk.....',
      '................',
      '................',
    ],
  },
  stuffed: {
    palette: OVER,
    rows: [
      '................',
      '..t.kkkkkkkk.t..',
      '...kcccccccck...',
      '..kcccccccccck..',
      '.kcccccccccccck.',
      '.kkkkkkkkkkkkkk.',
      '.kcwkcccccwkcck.',
      '.kcccccccccccck.',
      '.kcbbcccccbbcck.',
      '.kcc......cccck.',
      '.kcccccccccccck.',
      '.kkkkkkkkkkkkkk.',
      '..k........k....',
      '..kk......kk....',
      '................',
      '................',
    ],
  },
  torn: {
    palette: OVER,
    rows: [
      '................',
      '....kkkkkkkk....',
      '...kcccccccck...',
      '..kccccckcccck..',
      '..kkkkkckkkkkk..',
      '..kccccbccccck..',
      '..kcwkccccwkck..',
      '..kcccccccccck..',
      '..kc......ccck..',
      '..kcccccccccck..',
      '..kcccckccccck..',
      '..kkkkkkkkkkkk..',
      '...k......k.....',
      '...kk....kk.....',
      '................',
      '................',
    ],
  },
  busy: {
    palette: HAPPY,
    rows: [
      '................',
      '....kkkkkkkk....',
      '...kddddddddk...',
      '..kddddddddddk..',
      '..kkkkkkkkkkkk..',
      '..kcccccccccck..',
      '..kcwkccccwkck..',
      '..kcccccccccck..',
      '..kcbccccccbck..',
      '..kcccccccccckww',
      '..kccccsccccckww',
      '..kkkkkkkkkkkk..',
      '...k......k.....',
      '...kk....kk.....',
      '................',
      '................',
    ],
  },
  squinting: {
    palette: WORRIED,
    rows: [
      '................',
      '..t.kkkkkkkk....',
      '...kddddddddk.t.',
      '..kddddddddddk..',
      '..kkkkkkkkkkkk..',
      '..kcccccccccck..',
      '..kckkcccckkck..',
      '..kcccccccccck..',
      '..kcccccccccck..',
      '..kcc.kkkk.cck..',
      '..kcccccccccck..',
      '..kkkkkkkkkkkk..',
      '...k......k.....',
      '...kk....kk.....',
      '................',
      '................',
    ],
  },
  asleep: {
    palette: HAPPY,
    rows: [
      '............kk..',
      '....kkkkkkkk.k..',
      '...kddddddddk...',
      '..kddddddddddk..',
      '..kkkkkkkkkkkk..',
      '..kcccccccccck..',
      '..kcccccccccck..',
      '..kc.kcccc.kck..',
      '..kcccccccccck..',
      '..kcc.kkkk.cck..',
      '..kcccccccccck..',
      '..kkkkkkkkkkkk..',
      '...k......k.....',
      '...kk....kk.....',
      '................',
      '................',
    ],
  },
};

export function Penny({ mood, caption }: { mood: PennyMood; caption: string }) {
  const sprite = SPRITES[mood];
  const rows = sprite.rows.map((row) => row.slice(0, SIZE).padEnd(SIZE, '.'));
  return (
    <PixelGrid
      className={`penny penny-${mood}`}
      rows={rows}
      palette={sprite.palette}
      size={SIZE}
      title={caption}
    />
  );
}
