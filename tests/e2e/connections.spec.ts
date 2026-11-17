import { test, expect } from '@playwright/test';
import { mkdirSync } from 'fs';

const ART = '/opt/cursor/artifacts/screenshots';

async function shot(page: import('@playwright/test').Page, name: string, width: number) {
  await page.setViewportSize({ width, height: width === 375 ? 1400 : 1100 });
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${ART}/${name}_${width}.png`, fullPage: true });
}

test.describe('Connections page', () => {
  test.beforeAll(() => {
    mkdirSync(ART, { recursive: true });
  });

  test('empty and mixed statuses at 375 and 1280', async ({ page, request }) => {
    test.setTimeout(90_000);
    const seed = await request.post('/api/dev/seed-ui', { data: { reviews: false } });
    expect(seed.ok()).toBeTruthy();

    const empty = await request.post('/api/dev/seed-connections', { data: { scenario: 'empty' } });
    expect(empty.ok()).toBeTruthy();
    await page.goto('/settings/connections');
    await expect(page.getByTestId('connections-shell')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('conn-email')).toHaveAttribute('data-status', 'unset');
    await expect(page.getByTestId('conn-calendar')).toHaveAttribute('data-status', 'unset');
    await expect(page.getByTestId('conn-location')).toHaveAttribute('data-status', 'unset');
    await expect(page.getByTestId('conn-extension')).toHaveAttribute('data-status', 'unset');
    await expect(page.getByTestId('conn-webhook')).toHaveAttribute('data-status', 'unset');
    await shot(page, 'connections_unset', 375);
    await shot(page, 'connections_unset', 1280);

    const mixed = await request.post('/api/dev/seed-connections', { data: { scenario: 'mixed' } });
    expect(mixed.ok()).toBeTruthy();
    await page.reload();
    await expect(page.getByTestId('conn-email')).toHaveAttribute('data-status', 'waiting');
    await expect(page.getByTestId('conn-calendar')).toHaveAttribute('data-status', 'healthy');
    await expect(page.getByTestId('conn-location')).toHaveAttribute('data-status', 'stale');
    await expect(page.getByTestId('conn-extension')).toHaveAttribute('data-status', 'error');
    await expect(page.getByTestId('conn-webhook')).toHaveAttribute('data-status', 'unset');
    await expect(page.getByTestId('gmail-verify')).toContainText('84729103');
    await expect(page.getByTestId('email-phase')).toContainText('waiting for a test alert');
    await expect(page.getByTestId('email-test-alert')).toBeVisible();
    await shot(page, 'connections_mixed', 375);
    await shot(page, 'connections_mixed', 1280);
  });

  test('member can mint and regenerate a private ingest address', async ({ page, request }) => {
    test.setTimeout(90_000);
    expect((await request.post('/api/dev/seed-ui', { data: { reviews: false } })).ok()).toBeTruthy();
    expect((await request.post('/api/dev/seed-connections', { data: { scenario: 'empty' } })).ok()).toBeTruthy();
    await page.goto('/settings/connections');
    await expect(page.getByTestId('email-phase')).toContainText('create your mailbox');
    await page.getByRole('button', { name: 'create mailbox' }).click();
    await expect(page.getByTestId('copy-email-address-value')).toContainText('@ingest.example.test');
    const first = await page.getByTestId('copy-email-address-value').innerText();
    await expect(page.getByTestId('copy-gmail-filter-value')).toContainText('uob.com.sg');
    await expect(page.getByTestId('email-test-alert')).toContainText('No test email yet');
    await page.getByRole('button', { name: 'regenerate address' }).click();
    await expect(page.getByTestId('copy-email-address-value')).not.toHaveText(first);
  });
});
