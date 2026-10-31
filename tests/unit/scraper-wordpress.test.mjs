// BRO-2729: fetchPage()'s Playwright tier navigated with waitUntil
// 'networkidle', which never settles on ad/analytics-heavy pages
// (hollywoodreporter.com, wordpress.com blogs, timeout.com on press night):
// goto threw at 30s and fetchPage reported 'All scraping methods failed' for
// a page that had loaded. Navigation is now DOMContentLoaded plus a bounded
// networkidle settle whose timeout is not an error.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { playwrightNavigationPlan, PLAYWRIGHT_SETTLE_MS, PLAYWRIGHT_TIER_DEADLINE_MS, settleAfterNavigation } = require('../../scripts/lib/scraper.js');

test('default navigation never waits for networkidle in goto; it settles, bounded', () => {
  const plan = playwrightNavigationPlan({});
  assert.equal(plan.waitUntil, 'domcontentloaded');
  assert.equal(plan.settleMs, PLAYWRIGHT_SETTLE_MS);
  assert.ok(PLAYWRIGHT_SETTLE_MS > 0 && PLAYWRIGHT_SETTLE_MS <= 20000);
});

test('fast and selector-waiting callers get no settle, as before', () => {
  assert.deepEqual(playwrightNavigationPlan({ fast: true }), { waitUntil: 'domcontentloaded', settleMs: 0 });
  assert.deepEqual(playwrightNavigationPlan({ playwrightWaitForSelector: '.x' }), { waitUntil: 'domcontentloaded', settleMs: 0 });
});

test('goto + settle + consent goBack stay inside the Playwright tier deadline', () => {
  // goto 30s, settle, then the 8s consent goBack (see _fetchWithPlaywrightInner).
  assert.ok(Number.isFinite(PLAYWRIGHT_TIER_DEADLINE_MS));
  assert.ok(30000 + PLAYWRIGHT_SETTLE_MS + 8000 < PLAYWRIGHT_TIER_DEADLINE_MS);
});

function fakePage(waitImpl) {
  const calls = [];
  return { calls, waitForLoadState: async (state, opts) => { calls.push([state, opts]); return waitImpl(); } };
}

test('a settle TimeoutError is swallowed: the DOMContentLoaded page is read', async () => {
  const page = fakePage(() => { const e = new Error('Timeout 15000ms exceeded'); e.name = 'TimeoutError'; throw e; });
  await settleAfterNavigation(page, { settleMs: PLAYWRIGHT_SETTLE_MS }, 'https://x.test/');
  assert.deepEqual(page.calls, [['networkidle', { timeout: PLAYWRIGHT_SETTLE_MS }]]);
});

test('any other settle error is rethrown so fetchPage tries the next tier', async () => {
  const page = fakePage(() => { throw new Error('Target page, context or browser has been closed'); });
  await assert.rejects(settleAfterNavigation(page, { settleMs: PLAYWRIGHT_SETTLE_MS }, 'https://x.test/'), /closed/);
});

test('settleMs 0 (fast / selector callers) never waits', async () => {
  const page = fakePage(() => { throw new Error('must not be called'); });
  await settleAfterNavigation(page, { settleMs: 0 }, 'https://x.test/');
  assert.equal(page.calls.length, 0);
});

test("no page.goto(...) call in scraper.js passes 'networkidle', multi-line calls included", () => {
  const src = fs.readFileSync(new URL('../../scripts/lib/scraper.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const calls = [];
  for (const m of src.matchAll(/page\.goto\(/g)) {
    let depth = 0, i = m.index + m[0].length - 1;
    for (; i < src.length; i++) { if (src[i] === '(') depth++; else if (src[i] === ')' && --depth === 0) break; }
    calls.push(src.slice(m.index, i + 1));
  }
  assert.ok(calls.length > 0);
  for (const c of calls) assert.ok(!/networkidle/.test(c), c);
  // The goto's waitUntil comes from the plan, never a literal that could say networkidle.
  assert.ok(!/waitUntil:\s*['"]networkidle/.test(src));
});
