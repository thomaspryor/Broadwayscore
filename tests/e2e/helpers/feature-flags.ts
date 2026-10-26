import { test } from '@playwright/test';
import { featureFlags } from '@/config/feature-flags';

/**
 * Skip a Playwright describe/test when a Next.js feature flag is disabled
 * for the test target. Reads the same typed `featureFlags` registry that
 * src/ code reads, so test gating tracks the runtime — no string-typed
 * env parsing, typos fail at compile time.
 *
 * Use inside a describe body or beforeEach. test.skip() is evaluated at
 * collection time, so all child tests are filtered out when the flag is off.
 *
 *   test.describe('/biz Dashboard', () => {
 *     requireFeature('commercial');
 *     // ... tests
 *   });
 */
export function requireFeature(flag: keyof typeof featureFlags) {
  test.skip(!featureFlags[flag], `Feature flag '${flag}' is disabled — skipping`);
}

/**
 * Skip while a just-released route is not on the target yet, on PRs only.
 * test.yml's e2e job tests production (TEST_BASE_URL) from pull_request runs
 * too, so a PR that releases a page and tests it would go red until it ships.
 * Main pushes wait for the deploy first and post-deploy runs come after it,
 * so outside pull_request a 404 still fails. Call from a beforeEach.
 */
export async function skipOnPrUntilLive(
  request: { get: (url: string, opts?: { maxRedirects?: number }) => Promise<{ status: () => number }> },
  path: string,
) {
  if (process.env.GITHUB_EVENT_NAME !== 'pull_request') return;
  const status = (await request.get(path, { maxRedirects: 0 })).status();
  test.skip(status === 404, `${path} is not deployed to the target yet (PR run)`);
}
