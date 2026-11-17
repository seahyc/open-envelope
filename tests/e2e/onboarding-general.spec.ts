import { test, expect } from '@playwright/test';
import { mkdirSync } from 'fs';

const ART = '/opt/cursor/artifacts/screenshots';

async function resetOnboarding(request: import('@playwright/test').APIRequestContext) {
  const res = await request.post('/api/dev/reset-onboarding');
  expect(res.ok()).toBeTruthy();
}

async function walkHappyPath(page: import('@playwright/test').Page) {
  await page.goto('/');
  await expect(page.getByTestId('onboard-shell')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('heading', { name: 'HI.' })).toBeVisible();
  await page.getByTestId('onboard-next').click();
  await page.fill('input[name="householdName"]', 'Garden Budget');
  await page.getByTestId('onboard-next').click();
  await expect(page.getByLabel('Currency')).toHaveValue('SGD');
  await page.getByTestId('onboard-next').click();
  await page.getByTestId('onboard-next').click();
  await page.getByTestId('onboard-skip-invite').click();
  await page.fill('input[name="accountName"]', 'Joint Checking');
  await page.getByTestId('onboard-next').click();
  await page.fill('input[name="startingBalance"]', '5000');
  await page.getByTestId('onboard-next').click();
  await page.getByTestId('onboard-next').click();
  await expect(page.getByTestId('onboard-assign')).toBeVisible();
  await page.getByTestId('onboard-finish').click();
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 10_000 });
}

test.describe('General onboarding', () => {
  test.beforeAll(() => {
    mkdirSync(ART, { recursive: true });
  });

  for (const width of [375, 1280] as const) {
    test(`happy path at ${width}`, async ({ page, request }) => {
      await resetOnboarding(request);
      await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
      await walkHappyPath(page);
      await page.screenshot({ path: `${ART}/onboard_home_${width}.png`, fullPage: true });
    });

    test(`welcome empty state at ${width}`, async ({ page, request }) => {
      await resetOnboarding(request);
      await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
      await page.goto('/');
      await expect(page.getByTestId('onboard-shell')).toBeVisible({ timeout: 10_000 });
      await page.screenshot({ path: `${ART}/onboard_welcome_${width}.png`, fullPage: true });
    });
  }

  for (const width of [375, 1280] as const) {
    test(`skip data-in and resume after reload at ${width}`, async ({ page, request }) => {
      await resetOnboarding(request);
      await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
      await page.goto('/');
      await expect(page.getByTestId('onboard-shell')).toBeVisible({ timeout: 10_000 });
      await page.getByTestId('onboard-next').click();
      await page.getByRole('button', { name: /skip — call it Household/i }).click();
      await page.getByTestId('onboard-next').click();
      await page.reload();
      await expect(page.getByTestId('onboard-resume')).toBeVisible({ timeout: 10_000 });
      await page.screenshot({ path: `${ART}/onboard_resume_${width}.png`, fullPage: true });
      await page.getByTestId('onboard-start-over').click();
      await expect(page.getByRole('heading', { name: 'HI.' })).toBeVisible();
      await page.getByTestId('onboard-next').click();
      await page.getByTestId('onboard-next').click();
      await page.getByTestId('onboard-next').click();
      await page.getByTestId('onboard-next').click();
      await page.getByTestId('onboard-skip-invite').click();
      await page.getByTestId('onboard-skip-data').click();
      await page.getByRole('button', { name: /I'll add later/i }).click();
      await page.getByTestId('onboard-finish').click();
      await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 10_000 });
    });

    test(`unknown format path at ${width}`, async ({ page, request }) => {
      await resetOnboarding(request);
      await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
      await page.goto('/');
      await expect(page.getByTestId('onboard-shell')).toBeVisible({ timeout: 10_000 });
      await page.getByTestId('onboard-next').click();
      await page.getByTestId('onboard-next').click();
      await page.getByTestId('onboard-next').click();
      await page.getByTestId('onboard-next').click();
      await page.getByTestId('onboard-skip-invite').click();
      await page.setInputFiles('input[name="statement"]', {
        name: 'mystery.bin',
        mimeType: 'application/octet-stream',
        buffer: Buffer.from('nope'),
      });
      await expect(page.getByTestId('onboard-unknown-format')).toBeVisible();
      await page.screenshot({ path: `${ART}/onboard_unknown_${width}.png`, fullPage: true });
    });

    test(`P2 invite invalid state at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
      await page.goto('/join/not-a-real-token');
      await expect(page.getByTestId('invite-shell')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText(/doesn't work/i)).toBeVisible();
      await page.screenshot({ path: `${ART}/onboard_invite_invalid_${width}.png`, fullPage: true });
    });

    test(`P2 accept invite at ${width}`, async ({ page, request }) => {
      await resetOnboarding(request);
      await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
      await page.goto('/');
      await expect(page.getByTestId('onboard-shell')).toBeVisible({ timeout: 10_000 });
      await page.getByTestId('onboard-next').click();
      await page.fill('input[name="householdName"]', 'Garden Budget');
      await page.getByTestId('onboard-next').click();
      await page.getByTestId('onboard-next').click();
      await page.getByTestId('onboard-next').click();
      await page.getByRole('button', { name: /send invite/i }).click();
      await expect(page.getByTestId('onboard-invite-sent')).toBeVisible();
      const url = await page.getByTestId('onboard-invite-url').innerText();
      await page.screenshot({ path: `${ART}/onboard_invite_sent_${width}.png`, fullPage: true });
      await page.goto(url);
      await expect(page.getByTestId('invite-shell')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText(/Garden Budget/i)).toBeVisible();
      await page.fill('input[name="partnerName"]', 'Sam');
      await page.locator('input[name="consent"]').check();
      await page.screenshot({ path: `${ART}/onboard_invite_join_${width}.png`, fullPage: true });
      await page.getByTestId('invite-join').click();
      await expect(page.getByTestId('app-shell').or(page.getByTestId('onboard-shell'))).toBeVisible({ timeout: 10_000 });
    });

    test(`household export and intelligence at ${width}`, async ({ page, request }) => {
      await resetOnboarding(request);
      await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
      await walkHappyPath(page);
      await page.getByRole('button', { name: 'Accounts' }).click();
      await page.getByRole('button', { name: 'Household' }).click();
      await expect(page.getByTestId('household-shell')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId('household-llm')).toContainText(/memory|rules|categoriser/i);
      await page.screenshot({ path: `${ART}/onboard_household_${width}.png`, fullPage: true });
      await page.getByTestId('household-export').click();
      await expect(page.getByTestId('household-exported')).toBeVisible();
    });
  }
});
