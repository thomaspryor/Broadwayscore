// BRO-6008 (BRO-32 batch 2): migrated scripts stay off direct provider calls,
// and the new fetchPage options (tiers / wait / countryCode) behave.
// Requires the REAL functions per CLAUDE.md rule 15.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '../..');
const { scanSourceForDirectProviderCalls } = require('../../scripts/lib/direct-provider-detector');
const { _providerPassthroughParams } = require('../../scripts/lib/scraper');
const { fetchWithBrightDataViaFetchPage, brightDataWasCapped } = require('../../scripts/lib/audience-page-fetch');

// LBO/LTD/SeatPlan are guarded by the baseline assertion below (audit --strict
// fails CI on a regression); their sources are not in test.yml's push paths, so
// this test must not read them (audit-toplevel-script-test-yml-coverage).
const BASELINE_MIGRATED = ['lbo', 'ltd', 'seatplan'].map((n) => `scripts/scrape-${n}-audience.js`);
const MIGRATED = [
  'scripts/scrape-show-score-audience.js',
  'scripts/sweep-we-aggregators.js',
  // BRO-32 batch 1
  'scripts/scrape-bww-reviews.js',
  'scripts/scrape-nyc-theatre-roundups.js',
  'scripts/recollect-for-scores.js',
  'scripts/fetch-square-images.js',
  'scripts/fetch-all-image-formats.js',
  'scripts/backfill-cast-web.js',
  'scripts/verify-reviews.ts',
  'scripts/gather-reviews.js',
  'scripts/scrape-lottery-rush.js',
];

for (const rel of MIGRATED) {
  test(`${rel} makes no direct provider content-fetch call`, () => {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const hits = scanSourceForDirectProviderCalls(src);
    assert.deepEqual(hits, [], `${rel} regressed to a direct provider call: ${JSON.stringify(hits)}`);
  });
}

test('baseline no longer lists the migrated scripts', () => {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/audit/direct-provider-calls-baseline.json'), 'utf8'));
  for (const rel of [...BASELINE_MIGRATED, ...MIGRATED]) assert.ok(!(rel in base.files), `${rel} still baselined`);
  assert.ok(Object.keys(base.files).length <= 1, 'baseline must only shrink');
});

test('passthrough: wait + countryCode map to SB and SD param names', () => {
  assert.equal(_providerPassthroughParams({ wait: 3000, countryCode: 'GB' }, 'sb', true), '&wait=3000&country_code=gb');
  assert.equal(_providerPassthroughParams({ wait: 3000, countryCode: 'gb' }, 'sd', true), '&wait=3000&country=gb');
});

test('passthrough: wait dropped without JS render; invalid values dropped', () => {
  assert.equal(_providerPassthroughParams({ wait: 3000 }, 'sb', false), '');
  assert.equal(_providerPassthroughParams({ wait: -1, countryCode: 'gbr' }, 'sb', true), '');
  assert.equal(_providerPassthroughParams({ wait: 999999 }, 'sb', true), '');
  assert.equal(_providerPassthroughParams({}, 'sb', true), '');
});

test('BD-only helper: no token => null without calling fetchPage', async () => {
  const saved = process.env.BRIGHTDATA_TOKEN;
  delete process.env.BRIGHTDATA_TOKEN;
  try {
    let called = false;
    assert.equal(await fetchWithBrightDataViaFetchPage('https://x.test/a', async () => { called = true; }), null);
    assert.equal(called, false);
  } finally { if (saved !== undefined) process.env.BRIGHTDATA_TOKEN = saved; }
});

test('BD-only helper: restricts to brightdata tier, maps result and failure', async () => {
  process.env.BRIGHTDATA_TOKEN = 'test';
  let seen;
  const ok = await fetchWithBrightDataViaFetchPage('https://x.test/a', async (u, o) => { seen = o; return { content: '<html>' }; });
  assert.deepEqual(ok, { content: '<html>' });
  assert.deepEqual(seen.tiers, ['brightdata']);
  const miss = await fetchWithBrightDataViaFetchPage('https://x.test/a', async () => { throw new Error('All scraping methods failed'); });
  assert.equal(miss, null);
});

test('brightDataWasCapped reads bdBlocked', () => {
  assert.equal(brightDataWasCapped(() => ({ bdBlocked: 2 })), true);
  assert.equal(brightDataWasCapped(() => ({ bdBlocked: 0 })), false);
});

for (const rel of ['scripts/scrape-show-score-audience.js', 'scripts/sweep-we-aggregators.js']) {
  test(`${rel} raises SB_CREDIT_BUDGET before anything can load scraper.js`, () => {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const setAt = src.search(/process\.env\.SB_CREDIT_BUDGET\s*=/);
    const firstRequire = src.search(/^const .*require\(/m);
    assert.ok(setAt >= 0, 'budget default missing (fetchPage caps SB at 250cr/run)');
    assert.ok(setAt < firstRequire, 'must be set before the first require');
  });
}
