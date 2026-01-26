import { defineConfig, devices } from 'playwright/test';

/**
 * Playwright E2E Test Configuration
 *
 * Tests run against the production site (broadwayscore.vercel.app)
 * or a local build during CI.
 */
export default defineConfig({
  testDir: './tests/e2e',

  // Run tests in parallel
  fullyParallel: true,

  // Fail the build on CI if you accidentally left test.only in the source code
  forbidOnly: !!process.env.CI,

  // Retry failed tests (helps with flaky network issues)
  retries: process.env.CI ? 2 : 0,

  // Limit parallel workers on CI to avoid overloading
  workers: process.env.CI ? 2 : undefined,

  // Reporter configuration
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }], ['json', { outputFile: 'test-results/results.json' }]]
    : [['list'], ['html', { open: 'on-failure' }]],

  // Shared settings for all projects
  use: {
    // Base URL for tests - use production site
    baseURL: process.env.TEST_BASE_URL || 'https://broadwayscore.vercel.app',

    // Capture screenshot on failure
    screenshot: 'only-on-failure',

    // Capture video on failure
    video: 'retain-on-failure',

    // Capture trace on failure for debugging
    trace: 'retain-on-failure',

    // Timeout for actions
    actionTimeout: 15000,

    // Timeout for navigation
    navigationTimeout: 30000,
  },

  // Test timeout
  timeout: 60000,

  // Expect timeout
  expect: {
    timeout: 10000,
  },

  // Configure projects for different browsers
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile',
      use: { ...devices['iPhone 13'] },
    },
  ],

  // Output directory for test artifacts
  outputDir: 'test-results/',
});
