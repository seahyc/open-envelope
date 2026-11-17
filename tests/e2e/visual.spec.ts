import { test, expect } from '@playwright/test';
import { mkdirSync } from 'fs';

const ART = '/opt/cursor/artifacts/screenshots';

async function shot(page: import('@playwright/test').Page, name: string, width: number, height = width === 375 ? 812 : 900, fullPage = false) {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${ART}/${name}_${width}.png`, fullPage });
}

async function assertCenteredInMain(
  page: import('@playwright/test').Page,
  testId: string,
  tolerance = 8
) {
  const main = page.locator('main.shell-main');
  const el = page.getByTestId(testId);
  const mainBox = await main.boundingBox();
  const box = await el.boundingBox();
  expect(mainBox, `main box for ${testId}`).toBeTruthy();
  expect(box, `${testId} box`).toBeTruthy();
  const left = box!.x - mainBox!.x;
  const right = mainBox!.x + mainBox!.width - (box!.x + box!.width);
  expect(Math.abs(left - right), `${testId} left ${left} vs right ${right}`).toBeLessThanOrEqual(tolerance);
}

test.describe('Charlie visual', () => {
  test.beforeAll(() => {
    mkdirSync(ART, { recursive: true });
  });

  test('home, review groups/empty/error, accounts, pipeline at 375 and 1280', async ({ page, request }) => {
    test.setTimeout(120_000);
    const seed = await request.post('/api/dev/seed-ui', { data: { reviews: true } });
    expect(seed.ok()).toBeTruthy();

    await page.goto('/');
    await expect(page.getByTestId('home-shell')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('home-hero')).toBeVisible();
    await expect(page.getByTestId('home-cta')).toBeVisible();
    await expect(page.getByTestId('home-budget-pill')).toBeVisible();
    await expect(page.getByTestId('home-hero')).not.toContainText('Ready to assign');
    await expect(page.getByTestId('home-hero')).not.toContainText('S$0.00');
    await expect(page.getByTestId('home-spent')).toBeVisible();
    await expect(page.getByTestId('home-accounts')).toBeVisible();
    await expect(page.getByTestId('home-recent')).toBeVisible();
    await expect(page.getByTestId('home-account-uiseed-visa')).toContainText('needs starting balance');
    await expect(page.getByTestId('home-recent')).not.toContainText(/FAST PAYMENT via PayNow/i);
    await expect(page.getByTestId('home-recent')).toContainText('Above All Enterprise');
    await expect(page.getByTestId('home-spent')).not.toContainText('S$504,018.75');
    await expect(page.getByTestId('home-latest-data')).toBeVisible();
    await expect(page.getByTestId('home-spent-delta')).toHaveCount(0);
    await expect(page.getByTestId('home-spent')).not.toContainText(/vs last month/i);
    for (const width of [1024, 1440] as const) {
      await page.setViewportSize({ width, height: width === 1024 ? 768 : 900 });
      await page.waitForTimeout(150);
      await assertCenteredInMain(page, 'home-hero');
      await assertCenteredInMain(page, 'home-cta');
      const hero = await page.getByTestId('home-hero').boundingBox();
      const cta = await page.getByTestId('home-cta').boundingBox();
      expect(hero && cta).toBeTruthy();
      expect(hero!.width, `hero should stay a readable cluster at ${width}`).toBeLessThan(cta!.width - 40);
      if (width === 1440) {
        expect(cta!.width).toBeGreaterThan(1000);
        expect(cta!.width).toBeLessThanOrEqual(1048);
      }
      await shot(page, 'home', width, width === 1024 ? 768 : 900, true);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(150);
    const spent = await page.getByTestId('home-spent').boundingBox();
    const accounts = await page.getByTestId('home-accounts').boundingBox();
    const recent = await page.getByTestId('home-recent').boundingBox();
    const cta1280 = await page.getByTestId('home-cta').boundingBox();
    expect(spent && accounts && recent && cta1280).toBeTruthy();
    expect(Math.abs(spent!.y - accounts!.y)).toBeLessThan(48);
    expect(accounts!.x).toBeGreaterThan(spent!.x + 80);
    expect(cta1280!.y).toBeLessThan(spent!.y);
    expect(recent!.y).toBeGreaterThan(spent!.y + 40);
    expect(Math.abs(recent!.width - cta1280!.width)).toBeLessThan(24);
    await shot(page, 'home', 1280, 900, true);
    await shot(page, 'home', 375, 1400, true);

    await page.setViewportSize({ width: 1280, height: 900 });
    const reviewApi = await request.get('/api/review');
    expect(reviewApi.ok()).toBeTruthy();
    const listed = await reviewApi.json() as {
      items: Array<{ merchantText: string; researchPending: boolean; suggestedCategoryId: string | null; suggestedCategoryLabel: string | null }>;
      groups: Array<{ merchantText: string; suggestedCategoryLabel: string | null; items: Array<{ researchPending: boolean }> }>;
    };
    const contractorApi = listed.items.find((row) => /LIM AH HOCK/i.test(row.merchantText));
    const contractorApiGroup = listed.groups.find((row) => /LIM AH HOCK/i.test(row.merchantText));
    expect(contractorApi?.researchPending, JSON.stringify(contractorApi)).toBe(true);
    expect(contractorApi?.suggestedCategoryId).toBeNull();
    expect(contractorApiGroup?.suggestedCategoryLabel).toBeNull();
    expect(contractorApiGroup?.items.some((row) => row.researchPending)).toBe(true);
    await page.goto('/review');
    await expect(page.getByTestId('review-groups')).toBeVisible();
    await expect(page.getByTestId('review-card')).toBeVisible();
    await page.getByTestId('review-groups').getByText(/ABOVE ALL ENTERP/i).click();
    await expect(page.getByTestId('review-probably-was')).toContainText('coffee shop');
    await expect(page.getByTestId('review-entity')).toContainText('ABOVE ALL ENTERPRISE PTE. LTD.');
    await expect(page.getByTestId('review-entity')).toContainText('registered Apr 2026');
    await expect(page.getByTestId('review-entity-source')).toHaveAttribute(
      'href',
      'https://opengovsg.com/corporate/202615975E'
    );
    await expect(page.getByTestId('review-entity-source')).toHaveAttribute('target', '_blank');
    await expect(page.getByTestId('review-entity-source')).toHaveText('opengovsg');
    await expect(page.getByTestId('review-that-day')).toHaveText('That day: nothing on your calendars · no location recorded');
    await expect(page.getByTestId('review-researching')).toHaveCount(0);
    await expect(page.getByTestId('review-guess-reason')).toContainText('coffee shop');
    await expect(page.getByTestId('review-payee-label')).toHaveValue('Above All Enterprise');
    await expect(page.getByTestId('review-payee')).not.toContainText('Renovation contractor');
    const contractorGroup = page.getByTestId('review-groups').locator('button').filter({ hasText: /LIM AH HOCK/i });
    await expect(contractorGroup).toContainText('Researching…');
    await expect(contractorGroup).not.toContainText('Housing');
    await shot(page, 'review_enrichment', 1280, 1400, true);
    await shot(page, 'review_enrichment', 375, 1600, true);
    await page.getByTestId('review-groups').getByText(/LIM AH HOCK/i).click();
    await expect(page.getByTestId('review-payee')).toContainText('LIM AH HOCK');
    await expect(page.getByTestId('review-researching')).toHaveCount(0);
    await expect(page.getByTestId('review-probably-was')).toBeVisible();
    await expect(page.getByTestId('review-entity')).toHaveCount(0);
    await expect(page.getByTestId('review-that-day')).toHaveText('That day: nothing on your calendars · no location recorded');
    await expect(page.getByTestId('review-guess-reason')).toHaveText('no research match');
    await expect(page.getByTestId('review-payee-label')).toHaveValue('Lim Ah Hock');
    await shot(page, 'review_no_registry', 1280, 1400, true);
    await shot(page, 'review_no_registry', 375, 1600, true);
    await page.getByTestId('review-groups').getByText(/JEWEL CHANGI/i).click();
    await expect(page.getByTestId('review-that-day')).toContainText('Dinner');
    await expect(page.getByTestId('review-that-day')).toContainText('at Jewel Changi 2:10–2:40pm');
    await expect(page.getByTestId('review-context')).toBeVisible();
    await expect(page.getByTestId('review-context')).toContainText('Shopee order #220101: 2 items');
    await expect(page.getByTestId('review-context')).toContainText('Alex spent');
    await shot(page, 'review_context', 1280);
    await shot(page, 'review_context', 375);
    await page.getByTestId('review-groups').getByText(/Kopi Corner/).click();
    await expect(page.getByTestId('review-bulk')).toBeVisible();
    await shot(page, 'review_groups', 1024, 768);
    await shot(page, 'review_groups', 1440);
    await shot(page, 'review_groups', 1280);
    await shot(page, 'review_groups', 375);

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.route('**/api/review', (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'boom' }),
        });
      }
      return route.continue();
    });
    await page.goto('/review');
    await expect(page.getByTestId('review-error')).toBeVisible();
    await shot(page, 'review_error', 1280);
    await shot(page, 'review_error', 375);
    await page.unrouteAll({ behavior: 'ignoreErrors' });

    const emptied = await request.post('/api/dev/seed-ui', { data: { reviews: false } });
    expect(emptied.ok()).toBeTruthy();
    await page.goto('/review');
    await expect(page.getByTestId('review-empty')).toBeVisible();
    await expect(page.getByTestId('review-clear')).toBeVisible();
    await expect(page.getByTestId('review-reward')).toBeVisible();
    await shot(page, 'review_empty', 1280);
    await shot(page, 'review_empty', 375);

    await page.goto('/accounts');
    await expect(page.getByTestId('accounts-shell')).toBeVisible();
    await shot(page, 'accounts', 1280);
    await shot(page, 'accounts', 375);

    const pipeline = await request.post('/api/pipeline/seed-synthetic');
    expect(pipeline.ok()).toBeTruthy();

    await page.goto('/pipeline');
    await expect(page.getByRole('heading', { name: 'Import pipeline' })).toBeVisible();
    await expect(page.getByTestId('pipeline-graph')).toBeVisible();
    await shot(page, 'pipeline', 1280);
    await shot(page, 'pipeline', 375);
  });
});
