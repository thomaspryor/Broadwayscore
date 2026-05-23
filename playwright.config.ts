import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E Test Configuration
 *
 * Tests run against the production site (broadwayscore.vercel.app)
 * or a local build during CI.
 */
export default defineConfig({
  testDir: './tests/e2e',

  // UGC tests need local dev server with userAccounts flag.
  // Excluded by default (main CI hits production). Set RUN_UGC_TESTS=1 to include them.
  testIgnore: process.env.RUN_UGC_TESTS
    ? []
    : [
        '**/my-shows-mock*',
        '**/my-shows-functional*',
        '**/show-rating-functional*',
        '**/ugc-interactive-qa*',
        '**/ugc-visual-regression*',
        '**/ugc-visual-baselines*',
      ],

  // Run tests in parallel
  fullyParallel: true,

  // Fail the build on CI if you accidentally left test.only in the source code
  forbidOnly: !!process.env.CI,

  // Retry failed tests (helps with flaky network issues)
  retries: process.env.CI ? 2 : 0,

  // 4 workers on CI: smoke tests are read-only against production (no shared state
  // between tests, no dev server). retries=2 absorbs any cold-cache flake from the
  // higher concurrency. Cuts smoke step from ~1m 45s to ~52s.
  workers: process.env.CI ? 4 : undefined,

  // Reporter configuration
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }], ['json', { outputFile: 'test-results/results.json' }]]
    : [['list'], ['html', { open: 'on-failure' }]],

  // Shared settings for all projects
  use: {
    // Base URL for tests - use production site (custom domain)
    baseURL: process.env.TEST_BASE_URL || 'https://broadwayscorecard.com',

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
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.03,
      threshold: 0.3,
      animations: 'disabled',
    },
  },

  // Snapshot path organization
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{testFilePath}/{arg}{ext}',

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
