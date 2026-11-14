import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { claimsOutletCoverage, addClaimedOutletIds } = require('../../scripts/lib/outlet-coverage-claim.js');

test('url-less stagedoor row does not claim its outlet', () => {
  assert.equal(claimsOutletCoverage({ outletId: 'nytimes', url: '', source: 'stagedoor' }), false);
});
test('stagedoor row with a url still claims', () => {
  assert.equal(claimsOutletCoverage({ outletId: 'nytimes', url: 'https://x.test/a', source: 'stagedoor' }), true);
});
test('url-less rows from other sources keep claiming (resolved later)', () => {
  assert.equal(claimsOutletCoverage({ outletId: 'vulture', url: '', source: 'bww-roundup' }), true);
});
test('row without outletId never claims', () => {
  assert.equal(claimsOutletCoverage({ url: 'https://x.test', source: 'serp' }), false);
});
test('addClaimedOutletIds lowercases and skips non-claimants', () => {
  const s = addClaimedOutletIds(new Set(), [
    { outletId: 'NYTimes', url: '', source: 'stagedoor' },
    { outletId: 'Variety', url: 'https://v.test', source: 'dtli' },
  ]);
  assert.deepEqual([...s], ['variety']);
});

test('buildStagedoorRow shapes a url-less row that cannot claim coverage', () => {
  const { buildStagedoorRow } = require('../../scripts/lib/outlet-coverage-claim.js');
  const row = buildStagedoorRow({ outlet: 'Time Out', stars: 4, excerpt: 'x' }, { showId: 's-1', outletId: 'timeout' });
  assert.equal(row.url, '');
  assert.equal(row.urlless, true);
  assert.equal(row.score, 80);
  assert.equal(row.showId, 's-1');
  assert.equal(claimsOutletCoverage(row), false);
});
