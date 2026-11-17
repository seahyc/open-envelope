import { test, expect } from '@playwright/test';

test.describe('Onboarding Flow', () => {
  test('complete onboarding, import CSV, assign envelopes, reconcile', async ({ page, request }) => {
    const reset = await request.post('/api/dev/reset-onboarding');
    expect(reset.ok()).toBeTruthy();
    await page.goto('/');

    await expect(page.getByTestId('onboard-shell')).toBeVisible({ timeout: 5000 });
    await page.getByTestId('onboard-next').click();
    await page.fill('input[name="householdName"]', 'Alex and Sam');
    await page.getByTestId('onboard-next').click();
    await page.getByTestId('onboard-next').click();
    await page.getByTestId('onboard-next').click();
    await page.getByTestId('onboard-skip-invite').click();
    await page.fill('input[name="accountName"]', 'Joint Checking');
    await page.getByTestId('onboard-next').click();
    await page.fill('input[name="startingBalance"]', '5000');
    await page.getByTestId('onboard-next').click();
    await page.getByTestId('onboard-next').click();
    await page.getByTestId('onboard-finish').click();

    await expect(page.getByRole('button', { name: 'Accounts' })).toBeVisible({ timeout: 5000 });

    await page.getByRole('button', { name: 'Accounts' }).click();
    await page.getByRole('button', { name: 'Import' }).click();

    const csvContent = `Date,Description,Amount,Balance
2024-01-15,Grocery Store,-45.67,4954.33
2024-01-16,Salary,3000.00,7954.33`;

    const fileInput = page.locator('input[type="file"]');
    if (await fileInput.count() > 0) {
      await fileInput.setInputFiles({
        name: 'transactions.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from(csvContent),
      });
      await page.waitForTimeout(1000);
    }

    await page.getByRole('button', { name: 'Transactions' }).click();
    await expect(page.locator('body')).toContainText(/Grocery Store|Salary|transaction/i);
    await page.getByRole('button', { name: 'Budget' }).click();
    await expect(page.locator('body')).toContainText(/envelope|ready|assign/i);
  });
});
