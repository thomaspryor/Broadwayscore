// BRO-7162 F04: a site-search ERROR must not count as a miss toward outlet give-up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ss = require('../../scripts/lib/site-search-discovery.js');
const { countableMissIds, updateOutletMisses, isOutletGivenUp, DEFAULT_GIVEUP_THRESHOLD } = require('../../scripts/lib/js-outlet-giveup.js');

test('searchOutletSite records failed vs confirmed-empty vs found', async () => {
  ss.SITE_SEARCH_ENDPOINTS.__t_fail = { name: 'T', fetchAndParse: async () => { throw new Error('timeout'); } };
  ss.SITE_SEARCH_ENDPOINTS.__t_empty = { name: 'T', fetchAndParse: async () => [] };
  const outcomes = {};
  assert.deepEqual(await ss.searchOutletSite('__t_fail', 'Show', { outcomes }), []);
  await ss.searchOutletSite('__t_empty', 'Show', { outcomes });
  assert.equal(outcomes.__t_fail, 'failed');
  assert.equal(outcomes.__t_empty, 'confirmed-empty');
  delete ss.SITE_SEARCH_ENDPOINTS.__t_fail; delete ss.SITE_SEARCH_ENDPOINTS.__t_empty;
});

test('ten failed ticks never reach the give-up threshold; ten honest misses do', () => {
  let misses = {};
  for (let i = 0; i < DEFAULT_GIVEUP_THRESHOLD; i++) {
    const ids = countableMissIds(['theatrely'], { theatrely: 'failed' }, (k) => k);
    misses = updateOutletMisses(misses, ids, new Set());
  }
  assert.equal(isOutletGivenUp(misses, 'theatrely'), false);
  for (let i = 0; i < DEFAULT_GIVEUP_THRESHOLD; i++) {
    const ids = countableMissIds(['theatrely'], { theatrely: 'confirmed-empty' }, (k) => k);
    misses = updateOutletMisses(misses, ids, new Set());
  }
  assert.equal(isOutletGivenUp(misses, 'theatrely'), true);
});

test('class guard: the poller feeds updateOutletMisses only through countableMissIds', () => {
  const src = fs.readFileSync(new URL('../../scripts/opening-night-poller.js', import.meta.url), 'utf8');
  assert.match(src, /attemptedEffectiveIds = countableMissIds\(/);
});
