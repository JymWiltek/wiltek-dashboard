import { defineConfig, devices } from '@playwright/test';

const PORT = parseInt(process.env.PORT || '4173', 10);

/**
 * Wiltek Portal QA — full functional + UX matrix.
 *
 * Tests run against a local static server (tests/serve.js) which also
 * stubs /api/proxy so the suite never depends on Apps Script.
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,           // matrix is huge; sequential is more deterministic
  workers: 1,
  reporter: [
    ['list'],
    ['json', { outputFile: 'tests/playwright-report.json' }],
  ],
  use: {
    baseURL: `http://localhost:${PORT}`,
    actionTimeout: 6_000,
    navigationTimeout: 15_000,
    screenshot: 'off',           // we capture our own per-page baselines
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'node tests/serve.js',
    url: `http://localhost:${PORT}/Wiltek_MASTER.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
});
