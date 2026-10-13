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
const { playwrightNavigationPlan, PLAYWRIGHT_SETTLE_MS } = require('../../scripts/lib/scraper.js');

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

test('goto + settle stay inside the Playwright tier deadline', () => {
  const src = fs.readFileSync(new URL('../../scripts/lib/scraper.js', import.meta.url), 'utf8');
  const deadline = Number(src.match(/PLAYWRIGHT_TIER_DEADLINE_MS = (\d+) \* 1000/)[1]) * 1000;
  assert.ok(30000 + PLAYWRIGHT_SETTLE_MS < deadline);
});

test("no page.goto in scraper.js waits for 'networkidle'", () => {
  const src = fs.readFileSync(new URL('../../scripts/lib/scraper.js', import.meta.url), 'utf8');
  const gotos = src.split('\n').filter(l => /page\.goto\(/.test(l) && !/^\s*\/\//.test(l));
  assert.ok(gotos.length > 0);
  for (const l of gotos) assert.ok(!/networkidle/.test(l), l.trim());
});
