import { defineConfig } from '@playwright/test';

// Set BASE_URL=https://sql-duel.<you>.workers.dev to run the same specs against production.
const baseURL = process.env.BASE_URL ?? 'http://localhost:8797';

export default defineConfig({
  testDir: './test/e2e',
  timeout: 120_000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL,
    browserName: 'chromium',
    viewport: { width: 390, height: 844 },
    trace: 'retain-on-failure',
  },
  webServer: process.env.BASE_URL
    ? undefined
    : {
        command: 'npx wrangler dev --port 8797',
        url: 'http://localhost:8797/',
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
