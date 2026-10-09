import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests for the dashboard: `npx playwright test` (see README → Tests).
 * Every test runs on a desktop, a phone and a tablet. Each worker starts its own copy of
 * e2e/server.py (made-up mail, fake mail server, fake AI) and each test gets a fresh mailbox.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  timeout: 45_000,
  expect: { timeout: 7_000 },
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'phone', use: { ...devices['iPhone 14'], browserName: 'chromium' } },
    { name: 'tablet', use: { ...devices['iPad (gen 7)'], browserName: 'chromium' } },
  ],
});
