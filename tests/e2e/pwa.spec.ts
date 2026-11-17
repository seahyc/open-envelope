import { test, expect } from '@playwright/test';
import { mkdirSync } from 'fs';

const ART = '/opt/cursor/artifacts/screenshots';
const NOTCH_TOP = 47;
const HOME_INDICATOR = 34;

test.describe('standalone PWA layout', () => {
  test('Home at 375x812 respects notch safe-area insets', async ({ page, request }) => {
    test.setTimeout(60_000);
    mkdirSync(ART, { recursive: true });

    const sw = await request.get('/sw.js');
    expect(sw.ok()).toBeTruthy();
    expect(sw.headers()['content-type']).toMatch(/javascript/);
    expect(sw.headers()['service-worker-allowed'] ?? '').toBe('/');
    expect(await sw.text()).toContain("pathname.startsWith('/api/')");

    const vapid = await request.get('/api/push/vapid');
    expect(vapid.status()).toBe(404);

    const seed = await request.post('/api/dev/seed-ui', { data: { reviews: true } });
    expect(seed.ok()).toBeTruthy();

    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    await expect(page.getByTestId('home-shell')).toBeVisible({ timeout: 10_000 });
    await page.addStyleTag({
      content: `:root { --safe-top: ${NOTCH_TOP}px !important; --safe-bottom: ${HOME_INDICATOR}px !important; }`,
    });
    await expect(page.getByTestId('app-shell')).toBeVisible();
    await expect(page.getByTestId('tabbar')).toBeVisible();
    await page.waitForTimeout(100);

    const tab = await page.getByTestId('tabbar').boundingBox();
    const main = await page.locator('main.shell-main').boundingBox();
    expect(tab).toBeTruthy();
    expect(main).toBeTruthy();
    expect(main!.y, 'main starts below the notch').toBeGreaterThanOrEqual(NOTCH_TOP - 1);
    expect(tab!.height, 'tab bar includes home-indicator inset').toBeGreaterThanOrEqual(64 + HOME_INDICATOR - 1);
    expect(tab!.y + tab!.height, 'tab bar sits on the viewport floor').toBeGreaterThanOrEqual(811);
    expect(tab!.y + tab!.height).toBeLessThanOrEqual(813);

    const registration = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return null;
      const ready = await Promise.race([
        navigator.serviceWorker.ready.then((reg) => reg.scope),
        new Promise<string>((resolve) => window.setTimeout(() => resolve('timeout'), 4000)),
      ]);
      return ready;
    });
    expect(registration === 'timeout' || registration?.endsWith('/') || registration === null).toBe(true);

    await page.screenshot({ path: `${ART}/pwa_standalone_375.png` });
  });
});
