import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PORT ?? 3100);
export const BASE_URL = process.env.TEST_DATA_BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0, // fresh data per test means there is nothing to retry around
  workers: process.env.CI ? 4 : undefined,
  reporter: [['list'], ['html', { open: 'never' }], ['junit', { outputFile: 'test-results/junit.xml' }]],
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL: BASE_URL,
    testIdAttribute: 'data-test',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Playwright starts the Practice Shop before the tests and stops it afterwards.
  webServer: {
    command: 'npm run app',
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: !process.env.CI,
    env: { PORT: String(PORT) },
  },
});
