import { test as base, expect } from '@playwright/test';

/**
 * `test` for EVERY e2e spec: import it instead of `@playwright/test`'s.
 *
 * Why (BRO-5893, sprint-plan-adsense.md B-T4): our e2e and post-deploy smoke
 * runs hit production, and AdSense counts impressions from our own automation
 * as invalid traffic, which can get the account banned. Its `context` override
 * aborts every request to Google's ad networks in every project, on top of
 * AdSlot's own isAutomatedBrowser() opt-out. tests/unit/e2e-ad-block-fixture.test.ts
 * fails if a spec imports `test` from '@playwright/test' directly.
 */
export const AD_NETWORK_URL_RE =
  /^https?:\/\/([^/?#]+\.)?(googlesyndication\.com|doubleclick\.net|adtrafficquality\.google|googleadservices\.com)(?=[/:?#]|$)/i;

// Wraps the built-in `context` fixture rather than an `auto` fixture, so the
// routes apply to every page a test opens, while data-only specs (no `page`,
// no `context`) still never launch a browser.
export const test = base.extend({
  context: async ({ context }, use) => {
    await context.route(AD_NETWORK_URL_RE, (route) => route.abort('blockedbyclient'));
    await use(context);
  },
});

export { expect };
