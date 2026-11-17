import { greyPalette, type Palette } from '../pixels';
import { PixelGrid } from './PixelGrid';

type Sprite = { size: number; rows: string[]; palette: Palette };

const INK = '#111111';
const CREAM = '#ffe29a';
const FLAP = '#f5c14a';
const SEAL = '#e24b4a';
const WHITE = '#ffffff';
const DONUT = '#3ddc84';
const DONUT_DARK = '#1f9d57';
const GOLD = '#f5c518';
const CYAN = '#3dd6f5';
const BROWN = '#c47a3a';
const TAN = '#f0d9b5';
const ORANGE = '#f4a259';
const BLUE = '#4c9be8';
const PURPLE = '#a56dff';
const GREEN = '#7cb342';
const SLATE = '#6b7c93';
const TEAL = '#2bb8b3';
const PINK = '#e86ba5';
const LIME = '#9ccc65';
const RED = '#e24b4a';

const SPRITES: Record<string, Sprite> = {
  home: {
    size: 12,
    palette: { k: INK, c: CREAM, d: FLAP, s: SEAL, w: WHITE },
    rows: [
      '............',
      '..kkkkkkkk..',
      '.kddddddddk.',
      'kkddddddddkk',
      'kkkkkkkkkkkk',
      'kcccccccccck',
      'kcwkccccwckk',
      'kcccsccsccck',
      'kcccccccccck',
      '.kkkkkkkkkk.',
      '..k......k..',
      '............',
    ],
  },
  review: {
    size: 12,
    palette: { k: INK, g: GOLD, c: CYAN, w: WHITE },
    rows: [
      '............',
      '..kkkkkk....',
      '.kgwccwgk...',
      '.kgccccgk...',
      '.kgwccwgk...',
      '..kkkkkk....',
      '.....kk.....',
      '......kk....',
      '.......kk...',
      '........kk..',
      '............',
      '............',
    ],
  },
  budget: {
    size: 12,
    palette: { k: INK, g: DONUT, d: DONUT_DARK, w: WHITE, y: GOLD },
    rows: [
      '............',
      '...kkkkkk...',
      '..kggggggk..',
      '.kg......gk.',
      '.kg.kyyk.gk.',
      '.kg.kyyk.gk.',
      '.kg......gk.',
      '.kg......gk.',
      '..kggggggk..',
      '...kkkkkk...',
      '............',
      '............',
    ],
  },
  ledger: {
    size: 12,
    palette: { k: INK, t: TAN, b: BROWN, r: RED },
    rows: [
      '............',
      '.kkkkkkkkkk.',
      '.kttttttttrk',
      '.kt.......rk',
      '.kt.bbbbb.rk',
      '.kt.......rk',
      '.kt.bbbbb.rk',
      '.kt.......rk',
      '.kt.bbbbb.rk',
      '.kttttttttrk',
      '.kkkkkkkkkk.',
      '............',
    ],
  },
  accounts: {
    size: 12,
    palette: { k: INK, b: BLUE, w: WHITE, g: GREEN },
    rows: [
      '............',
      '.....kk.....',
      '....kwwk....',
      '...kbbbbk...',
      '..kkkkkkkk..',
      '..kbwbbwbk..',
      '..kbwbbwbk..',
      '..kbbbbbbk..',
      '..kbwbbwbk..',
      '..kkkkkkkk..',
      '..kgk..kgk..',
      '............',
    ],
  },
  food: {
    size: 12,
    palette: { k: INK, o: ORANGE, g: GREEN, r: RED },
    rows: [
      '............',
      '.....gg.....',
      '....gkk.....',
      '...koooook..',
      '..koooooook.',
      '..korooorok.',
      '..koooooook.',
      '..koooooook.',
      '...koooook..',
      '....kkkk....',
      '............',
      '............',
    ],
  },
  transport: {
    size: 12,
    palette: { k: INK, b: BLUE, w: WHITE, y: GOLD },
    rows: [
      '............',
      '............',
      '..kkkkkkk...',
      '.kbwwbwwbk..',
      '.kbwwbwwbk..',
      'kkkkkkkkkkk.',
      'kbbbbbbbbbk.',
      'kbykbbbkybk.',
      '.kk.....kk..',
      '............',
      '............',
      '............',
    ],
  },
  retail: {
    size: 12,
    palette: { k: INK, p: PURPLE, w: WHITE },
    rows: [
      '............',
      '...kkkkkk...',
      '..kpwwwwpk..',
      '..kpwwwwpk..',
      '.kkkkkkkkkk.',
      '.kppppppppk.',
      '.kpwwwwwwpk.',
      '.kppppppppk.',
      '.kpwwkkwwpk.',
      '.kkkkkkkkkk.',
      '............',
      '............',
    ],
  },
  housing: {
    size: 12,
    palette: { k: INK, g: GREEN, b: BROWN, w: WHITE, r: RED },
    rows: [
      '............',
      '.....kk.....',
      '....kggk....',
      '...kggggk...',
      '..kggggggk..',
      '.kkkkkkkkkk.',
      '.kbwwbbwwbk.',
      '.kbwwbbwwbk.',
      '.kbbbbbbbbk.',
      '.kkkkkkkkkk.',
      '............',
      '............',
    ],
  },
  tax: {
    size: 12,
    palette: { k: INK, s: SLATE, w: WHITE, g: GOLD },
    rows: [
      '............',
      '...kkkkkk...',
      '..kswwwwsk..',
      '..ksgkkgsk..',
      '..kswwwwsk..',
      '..kkkkkkkk..',
      '..kswwwwsk..',
      '..ksgkkgsk..',
      '..kswwwwsk..',
      '...kkkkkk...',
      '............',
      '............',
    ],
  },
  income: {
    size: 12,
    palette: { k: INK, g: DONUT_DARK, y: GOLD, w: WHITE },
    rows: [
      '............',
      '.....kk.....',
      '....kyyk....',
      '....kyyk....',
      '...kkkkkk...',
      '..kggggggk..',
      '.kgwggggwgk.',
      '.kgggkkgggk.',
      '.kggggggggk.',
      '..kkkkkkkk..',
      '............',
      '............',
    ],
  },
  transfer: {
    size: 12,
    palette: { k: INK, t: TEAL, w: WHITE },
    rows: [
      '............',
      '............',
      '.kk....kkkk.',
      '.ktk..ktttk.',
      '.kttkkktttk.',
      '..kttttttk..',
      '..kttttttk..',
      '.kttkkktk...',
      '.ktttk.ktk..',
      '.kkkk...kk..',
      '............',
      '............',
    ],
  },
  refund: {
    size: 12,
    palette: { k: INK, p: PINK, w: WHITE },
    rows: [
      '............',
      '....kkkk....',
      '...kppppk...',
      '..kpwppwpk..',
      '..kppppppk..',
      '..kppwwppk..',
      '..kppppppk..',
      '...kppppk...',
      '....kkkk....',
      '.....kk.....',
      '.....kk.....',
      '............',
    ],
  },
  fee: {
    size: 12,
    palette: { k: INK, g: GOLD, w: WHITE },
    rows: [
      '............',
      '....kkkk....',
      '...kgwwgk...',
      '..kgwggwgk..',
      '..kggggggk..',
      '..kgwggwgk..',
      '..kggggggk..',
      '...kgwwgk...',
      '....kkkk....',
      '............',
      '............',
      '............',
    ],
  },
  interest: {
    size: 12,
    palette: { k: INK, l: LIME, y: GOLD },
    rows: [
      '............',
      '.....kk.....',
      '....kyyk....',
      '....kyyk....',
      '.....kk.....',
      '....kllk....',
      '...kllllk...',
      '..kllllllk..',
      '.kllllllllk.',
      '.kkkkkkkkkk.',
      '............',
      '............',
    ],
  },
  star: {
    size: 12,
    palette: { k: INK, g: GOLD, w: WHITE },
    rows: [
      '............',
      '.....kk.....',
      '....kggk....',
      'kkkkggggkkkk',
      '.kgggwgggk..',
      '..kgggggk...',
      '..kgggggk...',
      '.kggk..kggk.',
      '.kk......kk.',
      '............',
      '............',
      '............',
    ],
  },
};

const CATEGORY_NAMES: Record<string, string> = {
  food: 'food',
  transport: 'transport',
  retail: 'retail',
  housing: 'housing',
  home: 'housing',
  tax: 'tax',
  income: 'income',
  transfer: 'transfer',
  refund: 'refund',
  fee: 'fee',
  interest: 'interest',
};

export function categoryIconName(label: string | null | undefined): string {
  const l1 = (label ?? '').split(/[▸>]/)[0]?.trim().toLowerCase() ?? '';
  return CATEGORY_NAMES[l1] ?? 'star';
}

export function PixelIcon({
  name,
  active = true,
  title,
}: {
  name: string;
  active?: boolean;
  title?: string;
}) {
  const sprite = SPRITES[name] ?? SPRITES.star!;
  const palette = active ? sprite.palette : greyPalette(sprite.palette);
  return (
    <PixelGrid
      className={`pixel-icon ${active ? 'is-active' : 'is-idle'}`}
      rows={sprite.rows}
      palette={palette}
      size={sprite.size}
      title={title}
    />
  );
}
