// BRO-6909: scoring-delta's inclusion mirror must replay rebuild-all-reviews.js's
// skippedListingPage, and notice when only the pattern list changes. Before this,
// adding theatreboard.co.uk / Ground News / blog /tag/ pages replayed as
// 0 newly excluded while the real rebuild dropped them.
// Requires the real decideInclusion and review-guards (CLAUDE.md rule 15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { decideInclusion, FLAG_FIELDS } = require('./scoring-delta.js');
const guards = { ...require('./lib/review-guards.js'), __nonReviewUrlPatterns: require('./lib/non-review-url-patterns.js') };

const show = { id: 'memoriam-off-west-end-2026', title: 'Memoriam', openingDate: '2026-10-28', previewsStartDate: '2026-10-20', category: 'off-west-end' };
const base = { assignedScore: 70, contentTier: 'complete', fullText: 'x'.repeat(2000), publishDate: '2026-10-29', outletId: 'x' };

test('listing-page URLs are excluded, the hatches keep them', () => {
  for (const url of [
    'https://ground.news/article/memoriam-review-by-thespyinthestalls-at-southwark-playhouse',
    'https://theatreboard.co.uk/thread/16312/dogstar-hampstead-theatre',
    'https://cherylmarkosky.com/tag/english-national-opera/',
  ]) {
    assert.deepEqual(decideInclusion({ ...base, url }, show, guards), { included: false, reason: 'listingPage' }, url);
    assert.notEqual(decideInclusion({ ...base, url, listingPageUrlManualClear: true }, show, guards).reason, 'listingPage', url);
    assert.notEqual(decideInclusion({ ...base, url, humanReviewScore: 70 }, show, guards).reason, 'listingPage', url);
  }
  assert.notEqual(decideInclusion({ ...base, url: 'https://thespyinthestalls.com/2026/10/memoriam/' }, show, guards).reason, 'listingPage');
});

test('a side without the pattern lib does not exclude (old baselines)', () => {
  const bare = require('./lib/review-guards.js');
  assert.notEqual(decideInclusion({ ...base, url: 'https://ground.news/article/x' }, show, bare).reason, 'listingPage');
});

test('the hatch is a flag field', () => {
  assert.ok(FLAG_FIELDS.has('listingPageUrlManualClear'));
});
