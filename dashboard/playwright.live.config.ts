import { defineConfig, devices } from '@playwright/test';

// Drives a running dashboard with its real API and data (DASHBOARD_URL), not the fixtures of
// playwright.config.ts. It only reads: the server's API has no write route.
export default defineConfig({
  testDir: 'tests/live',
  outputDir: 'test-results/live',
  fullyParallel: true,
  workers: 6,
  timeout: 600_000,
  retries: 0,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.DASHBOARD_URL ?? 'http://127.0.0.1:7311',
    locale: 'en-US',
  },
  projects: [{ name: 'chromium' }],
});
