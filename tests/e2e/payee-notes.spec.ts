import { test, expect } from '@playwright/test';
import { mkdirSync } from 'fs';

const ART = '/opt/cursor/artifacts/screenshots';

async function shot(page: import('@playwright/test').Page, name: string, width: number) {
  await page.setViewportSize({ width, height: width === 375 ? 1400 : 1100 });
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${ART}/${name}_${width}.png`, fullPage: true });
}

test.describe('Payee notes', () => {
  test.beforeAll(() => {
    mkdirSync(ART, { recursive: true });
  });

  test('tags an opaque PayNow payee and marks a capital transfer at 375 and 1280', async ({ page, request }) => {
    test.setTimeout(90_000);
    const seed = await request.post('/api/dev/seed-ui', { data: { reviews: true } });
    expect(seed.ok()).toBeTruthy();

    for (const width of [375, 1280] as const) {
      await request.post('/api/dev/seed-ui', { data: { reviews: true } });
      await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
      await page.goto('/review');
      await expect(page.getByTestId('review-groups')).toBeVisible({ timeout: 10_000 });

      await page.getByTestId('review-groups').getByText(/LIM AH HOCK/i).click();
      await expect(page.getByTestId('review-payee')).toBeVisible();
      await expect(page.getByTestId('review-payee-capital')).toBeVisible();
      await shot(page, 'review_payee', width);

      await page.getByTestId('review-payee-label').fill('Renovation contractor');
      await page.getByTestId('review-payee-project').fill('Home renovation');
      await page.getByTestId('review-payee-save').click();
      await expect(page.getByTestId('review-groups').getByText(/LIM AH HOCK/i)).toHaveCount(0);

      await page.getByTestId('review-groups').getByText(/ABC HOUSING/i).click();
      await expect(page.getByTestId('review-card')).toContainText("CASHIER'S ORDER");
      await expect(page.getByTestId('review-payee-label')).toHaveValue(/Abc Housing/i);
      await expect(page.getByTestId('review-payee-project')).toHaveValue('');
      await expect(page.getByTestId('review-payee-capital')).toBeVisible();
      await shot(page, 'review_capital', width);
      await page.getByTestId('review-payee-capital').click();
      await expect(page.getByTestId('review-groups').getByText(/ABC HOUSING/i)).toHaveCount(0);
    }
  });
});
