import { test, expect } from '@playwright/test';
import { mkdirSync } from 'fs';

const ART = '/opt/cursor/artifacts/screenshots';

test.describe('Penny favicon', () => {
  test('production build serves icons and the web manifest', async ({ request, page }) => {
    test.setTimeout(30_000);
    mkdirSync(ART, { recursive: true });

    const html = await (await request.get('/')).text();
    expect(html).toContain('href="/favicon.svg"');
    expect(html).toContain('href="/favicon.ico"');
    expect(html).toContain('href="/apple-touch-icon.png"');
    expect(html).toContain('href="/manifest.webmanifest"');

    const svg = await (await request.get('/favicon.svg')).text();
    expect(svg).toContain('shape-rendering="crispEdges"');

    for (const path of ['/favicon.ico', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png', '/icon-512-maskable.png']) {
      const res = await request.get(path);
      expect(res.ok(), path).toBeTruthy();
      expect(res.headers()['content-type']).toMatch(/image\//);
    }

    const manifestRes = await request.get('/manifest.webmanifest');
    expect(manifestRes.ok()).toBeTruthy();
    expect(manifestRes.headers()['content-type']).toMatch(/manifest|json/);
    const manifest = await manifestRes.json();
    expect(manifest.name).toBe('OpenEnvelope');
    expect(manifest.short_name).toBe('Envelope');
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.theme_color).toBe('#ffffff');
    expect(manifest.background_color).toBe('#ffffff');
    expect(manifest.icons.some((icon: { purpose?: string; src: string }) => (
      icon.src === '/icon-512-maskable.png' && icon.purpose === 'maskable'
    ))).toBe(true);
    expect(html).toContain('apple-mobile-web-app-capable');
    expect(html).toContain('apple-mobile-web-app-title');

    await page.setViewportSize({ width: 420, height: 280 });
    await page.setContent(`<!DOCTYPE html>
<html>
  <head><base href="http://127.0.0.1:3100/"></head>
  <body style="margin:0;background:#ffffff;color:#111111;font-family:ui-monospace,monospace;">
    <div style="display:flex;align-items:flex-end;gap:28px;padding:28px 32px;">
      <figure style="margin:0;text-align:center;">
        <img src="/favicon.svg" width="16" height="16" alt="" style="image-rendering:pixelated;display:block;">
        <figcaption style="margin-top:8px;font-size:12px;">16</figcaption>
      </figure>
      <figure style="margin:0;text-align:center;">
        <img src="/favicon.ico" width="32" height="32" alt="" style="image-rendering:pixelated;display:block;">
        <figcaption style="margin-top:8px;font-size:12px;">32</figcaption>
      </figure>
      <figure style="margin:0;text-align:center;">
        <img src="/apple-touch-icon.png" width="180" height="180" alt="" style="image-rendering:pixelated;display:block;">
        <figcaption style="margin-top:8px;font-size:12px;">180</figcaption>
      </figure>
    </div>
  </body>
</html>`, { waitUntil: 'networkidle' });
    await page.screenshot({ path: `${ART}/penny_favicon_16_32_180.png` });
  });
});
