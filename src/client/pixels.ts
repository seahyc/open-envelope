export type Palette = Record<string, string>;

export function parseSprite(rows: string[], palette: Palette): Array<[number, number, string]> {
  const pixels: Array<[number, number, string]> = [];
  for (let y = 0; y < rows.length; y += 1) {
    const row = rows[y] ?? '';
    for (let x = 0; x < row.length; x += 1) {
      const ch = row[x]!;
      if (ch === '.' || ch === ' ') continue;
      const color = palette[ch];
      if (color) pixels.push([x, y, color]);
    }
  }
  return pixels;
}

export function greyPalette(palette: Palette, grey = '#c8c8c8'): Palette {
  const next: Palette = {};
  for (const key of Object.keys(palette)) {
    next[key] = grey;
  }
  return next;
}
