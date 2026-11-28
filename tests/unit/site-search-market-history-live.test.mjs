// LIVE-DATA-LANE: reads data/reviews.json and data/shows.json (untracked core data) to check the BRO-8268 never-covered-market answers on real coverage. Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const mh = require('../../scripts/lib/site-search-market-history.js');

mh._resetCacheForTests();
const REAL_COUNTS = mh.loadDomainCategoryCounts();
test('real data loads and gives the expected answers for the four JS outlets',
  { skip: !REAL_COUNTS && 'no data/reviews.json + shows.json in this checkout (CI checks out core data)' }, () => {
  const counts = REAL_COUNTS;
  const d = (domain, category) => mh.neverCoveredMarketDecision({ domain, category, counts, env: {} }).reason;
  assert.equal(d('deadline.com', 'broadway'), 'covered');
  assert.equal(d('ew.com', 'broadway'), 'covered');
  assert.equal(d('timeout.com', 'broadway'), 'covered');
  assert.equal(d('timeout.com', 'off-broadway'), 'covered');
  assert.equal(d('hollywoodreporter.com', 'west-end'), 'covered');
  assert.equal(d('deadline.com', 'west-end'), 'never-covered');
});
