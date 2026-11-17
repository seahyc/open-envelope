import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { crc32, deflateSync } from 'zlib';
import { parseSprite } from '../src/client/pixels.js';
import { PENNY_HAPPY_PALETTE, PENNY_HAPPY_ROWS, PENNY_SIZE } from '../src/client/penny-sprite.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'src/client/public');
const WHITE = '#ffffff';
const pixels = parseSprite(PENNY_HAPPY_ROWS, PENNY_HAPPY_PALETTE);

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const dest = y * (stride + 1);
    raw[dest] = 0;
    rgba.copy(raw, dest + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function hexRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function renderPenny(canvas: number, scale: number): Buffer {
  const rgba = Buffer.alloc(canvas * canvas * 4, 0);
  const [wr, wg, wb] = hexRgb(WHITE);
  for (let i = 0; i < canvas * canvas; i += 1) {
    const o = i * 4;
    rgba[o] = wr;
    rgba[o + 1] = wg;
    rgba[o + 2] = wb;
    rgba[o + 3] = 255;
  }
  const origin = Math.floor((canvas - PENNY_SIZE * scale) / 2);
  for (const [x, y, fill] of pixels) {
    const [r, g, b] = hexRgb(fill);
    for (let dy = 0; dy < scale; dy += 1) {
      for (let dx = 0; dx < scale; dx += 1) {
        const px = origin + x * scale + dx;
        const py = origin + y * scale + dy;
        const o = (py * canvas + px) * 4;
        rgba[o] = r;
        rgba[o + 1] = g;
        rgba[o + 2] = b;
        rgba[o + 3] = 255;
      }
    }
  }
  return encodePng(canvas, canvas, rgba);
}

function writeSvg(): string {
  const rects = pixels
    .map(([x, y, fill]) => `<rect x="${x}" y="${y}" width="1" height="1" fill="${fill}"/>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PENNY_SIZE} ${PENNY_SIZE}" width="${PENNY_SIZE}" height="${PENNY_SIZE}" shape-rendering="crispEdges"><rect width="${PENNY_SIZE}" height="${PENNY_SIZE}" fill="${WHITE}"/>${rects}</svg>\n`;
}

function writeIco(pngs: Array<{ size: number; png: Buffer }>): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = Buffer.alloc(16 * pngs.length);
  const blobs: Buffer[] = [];
  let offset = 6 + entries.length;
  pngs.forEach((image, index) => {
    const at = index * 16;
    entries[at] = image.size;
    entries[at + 1] = image.size;
    entries[at + 2] = 0;
    entries[at + 3] = 0;
    entries.writeUInt16LE(1, at + 4);
    entries.writeUInt16LE(32, at + 6);
    entries.writeUInt32LE(image.png.length, at + 8);
    entries.writeUInt32LE(offset, at + 12);
    blobs.push(image.png);
    offset += image.png.length;
  });
  return Buffer.concat([header, entries, ...blobs]);
}

mkdirSync(PUBLIC, { recursive: true });
writeFileSync(join(PUBLIC, 'favicon.svg'), writeSvg());
const ico16 = renderPenny(16, 1);
const ico32 = renderPenny(32, 2);
const ico48 = renderPenny(48, 3);
writeFileSync(join(PUBLIC, 'favicon.ico'), writeIco([
  { size: 16, png: ico16 },
  { size: 32, png: ico32 },
  { size: 48, png: ico48 },
]));
writeFileSync(join(PUBLIC, 'apple-touch-icon.png'), renderPenny(180, 8));
writeFileSync(join(PUBLIC, 'icon-192.png'), renderPenny(192, 12));
writeFileSync(join(PUBLIC, 'icon-512.png'), renderPenny(512, 32));
writeFileSync(join(PUBLIC, 'icon-512-maskable.png'), renderPenny(512, 24));
writeFileSync(join(PUBLIC, 'manifest.webmanifest'), `${JSON.stringify({
  name: 'OpenEnvelope',
  short_name: 'Envelope',
  id: '/',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: WHITE,
  theme_color: WHITE,
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
}, null, 2)}\n`);
