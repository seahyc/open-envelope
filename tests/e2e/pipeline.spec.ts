import { test, expect } from '@playwright/test';
import { mkdirSync } from 'fs';

test.describe('Pipeline viewer', () => {
  test('renders the graph from a seeded synthetic run', async ({ page, request }) => {
    test.setTimeout(60_000);
    const seed = await request.post('/api/pipeline/seed-synthetic');
    expect(seed.ok()).toBeTruthy();

    await page.setViewportSize({ width: 1600, height: 1100 });
    await page.goto('/pipeline');
    await expect(page.getByRole('heading', { name: 'Import pipeline' })).toBeVisible();
    await expect(page.getByTestId('pipeline-graph')).toBeVisible();
    await expect(page.getByTestId('pipeline-node-enrich-merchant')).toBeVisible();
    await expect(page.getByTestId('pipeline-node-triangulate')).toBeVisible();
    await expect(page.getByTestId('pipeline-node-categorize')).toBeVisible();
    const enrichBox = await page.getByTestId('pipeline-node-enrich-merchant').boundingBox();
    const thatDayBox = await page.getByTestId('pipeline-node-triangulate').boundingBox();
    const categorizeBox = await page.getByTestId('pipeline-node-categorize').boundingBox();
    expect(enrichBox && thatDayBox && categorizeBox).toBeTruthy();
    expect(enrichBox!.x).toBeLessThan(thatDayBox!.x);
    expect(thatDayBox!.x).toBeLessThan(categorizeBox!.x);
    await expect(page.getByTestId('pipeline-node-source:location')).toBeVisible();
    await expect(page.getByTestId('pipeline-node-source:calendar')).toBeVisible();
    await expect(page.getByTestId('pipeline-node-source:orders')).toBeVisible();
    await expect(page.getByTestId('pipeline-node-source:webhook')).toBeVisible();
    await expect(page.locator('.pipeline-node').first()).toBeVisible();
    await expect(page.locator('.react-flow__edge').first()).toBeVisible();
    await expect(page.getByTestId('pipeline-empty')).toHaveCount(0);

    await page.getByTestId('pipeline-node-ingest').evaluate((el) => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await expect(page.getByTestId('pipeline-panel')).toContainText(/Enabled|Last-run/i);
    await expect(page.getByTestId('pipeline-panel')).toContainText('••••7890');

    mkdirSync('/opt/cursor/artifacts/screenshots', { recursive: true });
    await page.screenshot({ path: '/opt/cursor/artifacts/screenshots/pipeline.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId('pipeline-graph')).toBeVisible();
  });
});
