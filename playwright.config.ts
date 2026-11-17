import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'html',
  use: {
    baseURL: 'http://127.0.0.1:3100',
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: 'npx vite build && npm run dev',
    url: 'http://127.0.0.1:3100',
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
    env: {
      PORT: '3100',
      DATABASE_PATH: ':memory:',
      AUTH_MODE: 'none',
      LOG_LEVEL: 'error',
      EMAIL_INGEST_DOMAIN: 'ingest.example.test',
      CONTEXT_LOCATION: '1',
      CONTEXT_CALENDAR: '1',
      CONTEXT_ORDERS: '1',
      CONTEXT_WEBHOOK: '1',
      MERCHANT_ENRICHMENT: 'off',
    },
  },
});
