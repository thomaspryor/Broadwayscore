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
