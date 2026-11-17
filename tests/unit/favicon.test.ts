import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseSprite } from '../../src/client/pixels';
import { PENNY_HAPPY_PALETTE, PENNY_HAPPY_ROWS, PENNY_SIZE } from '../../src/client/penny-sprite';

const PUBLIC = join(process.cwd(), 'src/client/public');

function pngSize(buf: Buffer): [number, number] {
  expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

describe('Penny favicon', () => {
  it('matches the happy sprite and is crisp-edged SVG', () => {
    const svg = readFileSync(join(PUBLIC, 'favicon.svg'), 'utf8');
    expect(svg).toContain('shape-rendering="crispEdges"');
    expect(svg).toContain(`viewBox="0 0 ${PENNY_SIZE} ${PENNY_SIZE}"`);
    for (const [x, y, fill] of parseSprite(PENNY_HAPPY_ROWS, PENNY_HAPPY_PALETTE)) {
      expect(svg).toContain(`x="${x}" y="${y}" width="1" height="1" fill="${fill}"`);
    }
  });

  it('packs 16, 32 and 48 into favicon.ico', () => {
    const ico = readFileSync(join(PUBLIC, 'favicon.ico'));
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(3);
    const sizes = [0, 1, 2].map((i) => ico[6 + i * 16]);
    expect(sizes).toEqual([16, 32, 48]);
  });

  it('ships apple-touch and PWA pngs at the required sizes', () => {
    expect(pngSize(readFileSync(join(PUBLIC, 'apple-touch-icon.png')))).toEqual([180, 180]);
    expect(pngSize(readFileSync(join(PUBLIC, 'icon-192.png')))).toEqual([192, 192]);
    expect(pngSize(readFileSync(join(PUBLIC, 'icon-512.png')))).toEqual([512, 512]);
    expect(pngSize(readFileSync(join(PUBLIC, 'icon-512-maskable.png')))).toEqual([512, 512]);
  });

  it('declares OpenEnvelope in the web manifest and index.html', () => {
    const manifest = JSON.parse(readFileSync(join(PUBLIC, 'manifest.webmanifest'), 'utf8')) as {
      name: string;
      short_name: string;
      display: string;
      start_url: string;
      scope: string;
      theme_color: string;
      background_color: string;
    };
    expect(manifest.name).toBe('OpenEnvelope');
    expect(manifest.short_name).toBe('Envelope');
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.theme_color).toBe('#ffffff');
    expect(manifest.background_color).toBe('#ffffff');
    const html = readFileSync(join(process.cwd(), 'src/client/index.html'), 'utf8');
    expect(html).toContain('rel="icon" type="image/svg+xml" href="/favicon.svg"');
    expect(html).toContain('rel="icon" href="/favicon.ico"');
    expect(html).toContain('rel="apple-touch-icon" href="/apple-touch-icon.png"');
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
  });

  it('copies the icons through Vite publicDir into the production client build', () => {
    const config = readFileSync(join(process.cwd(), 'vite.config.ts'), 'utf8');
    expect(config).toMatch(/root:\s*'src\/client'/);
    expect(config).toMatch(/publicDir:\s*'public'/);
    expect(config).toMatch(/outDir:\s*'..\/..\/dist\/client'/);
  });
});
