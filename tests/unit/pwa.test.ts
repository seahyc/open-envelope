import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/server/db/migrations.js';
import { PushService, webPushEnabled } from '../../src/server/services/push-service.js';

const ROOT = process.cwd();
const PUBLIC = join(ROOT, 'src/client/public');

function pngSize(buf: Buffer): [number, number] {
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

describe('installable PWA shell', () => {
  it('declares standalone display, root scope, and a maskable 512 icon', () => {
    const manifest = JSON.parse(readFileSync(join(PUBLIC, 'manifest.webmanifest'), 'utf8')) as {
      display: string;
      start_url: string;
      scope: string;
      icons: Array<{ src: string; sizes: string; purpose?: string }>;
    };
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.icons.some((icon) => icon.src === '/icon-512-maskable.png' && icon.purpose === 'maskable')).toBe(true);
    expect(pngSize(readFileSync(join(PUBLIC, 'icon-512-maskable.png')))).toEqual([512, 512]);
  });

  it('sets iOS home-screen meta tags', () => {
    const html = readFileSync(join(ROOT, 'src/client/index.html'), 'utf8');
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(html).toContain('name="apple-mobile-web-app-status-bar-style" content="default"');
    expect(html).toContain('name="apple-mobile-web-app-title" content="Envelope"');
    expect(html).toContain('viewport-fit=cover');
  });

  it('uses a shell-only service worker that never caches API responses', () => {
    const sw = readFileSync(join(PUBLIC, 'sw.js'), 'utf8');
    expect(sw).toContain("pathname.startsWith('/api/')");
    expect(sw).toContain('networkFirst');
    expect(sw).toContain("request.mode === 'navigate'");
    expect(sw).toContain('Never cache /api');
    expect(sw).not.toMatch(/\/api\/(transactions|review|home)/);
  });

  it('keeps Web Push off by default', () => {
    expect(webPushEnabled({})).toBe(false);
    expect(webPushEnabled({ WEB_PUSH: '1' })).toBe(true);
    const db = new Database(':memory:');
    runMigrations(db, { quiet: true });
    const push = new PushService(db);
    expect(push.vapidPublicKey({})).toBeNull();
    expect(push.vapidPublicKey({ WEB_PUSH: '1', VAPID_PUBLIC_KEY: 'test-key' })).toBe('test-key');
    const id = push.subscribe({
      endpoint: 'https://push.example/sub',
      keys: { p256dh: 'p', auth: 'a' },
    });
    expect(id).toBeTruthy();
    expect(db.prepare('SELECT COUNT(*) as n FROM push_subscriptions').get()).toEqual({ n: 1 });
    db.close();
  });
});
