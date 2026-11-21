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
  // Deadline mirror (BRO-5823, 2026-11-18).
  assert.equal(isBlockedReviewUrl('https://globalnews2.xyz/a-few-good-men-broadway-review-bradley-whitford-and-tom-blyth-handle-the-truth/'), true);
  const { isJunkOutlet } = require('./lib/review-normalization');
  for (const id of ['new-york-review', 'broadways-summer']) assert.equal(isJunkOutlet(id), true, id);
  // A substack.com/@<handle> profile link is the handle's publication, not an outlet named substack-com.
  const { planOutletMigration } = require('./lib/outlet-id-migrations');
  const moved = planOutletMigration({ outletId: 'substack-com', url: 'https://substack.com/@intelligentshowmosexual/p-221082570' }, 'substack-com--sloan-ciccone.json');
  assert.equal(moved && moved.to, 'showmosexualsguide');
  assert.equal(planOutletMigration({ outletId: 'substack-com', url: 'https://substack.com/@someoneelse/p-1' }, 'substack-com--x.json'), null);
});
