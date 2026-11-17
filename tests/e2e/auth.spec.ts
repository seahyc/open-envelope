import { test, expect } from '@playwright/test';
import { mkdirSync } from 'fs';

const ART = '/opt/cursor/artifacts/screenshots';

test.describe('Auth landing', () => {
  test.beforeAll(() => {
    mkdirSync(ART, { recursive: true });
  });

  for (const width of [375, 1280] as const) {
    test(`sign-in screen at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
      await page.goto('/signin');
      await expect(page.getByTestId('auth-shell')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByRole('heading', { name: /OpenEnvelope/i })).toBeVisible();
      await expect(page.getByPlaceholder('you@example.com')).toBeVisible();
      await expect(page.getByTestId('auth-magic-submit')).toBeDisabled();
      await page.fill('input[name="email"]', 'alex@example.test');
      await expect(page.getByTestId('auth-magic-submit')).toBeEnabled();
      await page.screenshot({ path: `${ART}/auth_signin_${width}.png`, fullPage: true });
    });
  }
});
