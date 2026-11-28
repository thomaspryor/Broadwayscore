// BRO-7162 F14 class guards: a SERP provider outage (serpQuery -> null) must not read as an honest empty
// answer, and the provider gate must count ScrapingDog like the shared chain does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { hasSerpProvider } = require('../../scripts/lib/url-discovery.js');
const read = p => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('hasSerpProvider counts ScrapingDog and rejects an empty environment', () => {
  const none = { scrapingBeeKey: '', brightDataKey: '', scrapingdogKey: '', useScrapingdog: true };
  assert.equal(hasSerpProvider(none), false);
  assert.equal(hasSerpProvider({ ...none, scrapingdogKey: 'k' }), true);
  assert.equal(hasSerpProvider({ ...none, scrapingdogKey: 'k', useScrapingdog: false }), false);
  assert.equal(hasSerpProvider({ ...none, scrapingBeeKey: 'k' }), true);
  assert.equal(hasSerpProvider({ ...none, brightDataKey: 'k' }), true);
});

test('audit census records a null serpQuery result as a failed query (source guard)', () => {
  const src = read('scripts/audit-show-review-gap.js');
  assert.match(src, /serpResults === null[\s\S]{0,300}ok: false[\s\S]{0,120}serp-provider-unavailable/);
  assert.doesNotMatch(src, /for \(const sr of \(serpResults \|\| \[\]\)\)/);
});

test('discovery script and poller gate on hasSerpProvider, not on SB/BD keys alone (source guard)', () => {
  assert.match(read('scripts/discover-opening-night-reviews.js'), /if \(!hasSerpProvider\(\)\)/);
  assert.match(read('scripts/opening-night-poller.js'), /if \(!hasSerpProvider\(\)\)/);
  assert.doesNotMatch(read('scripts/opening-night-poller.js'), /!process\.env\.SCRAPINGBEE_API_KEY && !process\.env\.BRIGHTDATA_TOKEN/);
});

test('recall census arm records a null serpQuery result as a failed arm (source guard)', () => {
  const src = read('scripts/audit-serp-census-recall.js');
  assert.match(src, /results === null\) return \{ urls, raw: 0, ok: false, error: 'serp-provider-unavailable'/);
  assert.doesNotMatch(src, /serpQuery\(query, \{ dateRange, preferSpeed: false, page, geo \}\) \|\| \[\]/);
});
