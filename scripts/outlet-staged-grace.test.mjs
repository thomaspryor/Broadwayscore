import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { recentlyStagedOutletIds } = require('./lib/outlet-auto-register.js');
const { isBlockedReviewUrl } = require('./lib/domain-filters.js');

const NOW = Date.parse('2026-10-26T12:00:00Z');
test('staged ids inside the grace window are pending, older ones are not', () => {
  const doc = { staged: [
    { outletId: 'fresh', firstSeenAt: '2026-10-25T00:00:00Z' },
    { outletId: 'old', firstSeenAt: '2026-10-01T00:00:00Z' },
    { outletId: 'nodate' },
    { outletId: 'future', firstSeenAt: '2027-01-01T00:00:00Z' },
  ] };
  assert.deepEqual([...recentlyStagedOutletIds(doc, NOW)], ['fresh']);
  assert.equal(recentlyStagedOutletIds(null, NOW).size, 0);
});
test('Time Out mirror host is blocked', () => {
  assert.equal(isBlockedReviewUrl('https://harunaenterprisesltd.com/pro/broadway-review-billy-crystal-in-860-a1imdgxpg1'), true);
});
