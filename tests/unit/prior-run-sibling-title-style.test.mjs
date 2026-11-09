// BRO-5489: "Othello (Bedlam)" (return) vs "Bedlam's Othello" (May run) are one production
// under two title styles. The venue+date prior-run match must still find the sibling so the
// gap audit treats its reviews as that run's, without carrying them onto the return.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { findPriorRunSiblings, collectHousedSiblingFiles } = require('../../scripts/lib/prior-run-sibling.js');

const may = { id: 'bedlams-othello-off-broadway-2026', title: "Bedlam's Othello", venue: 'West End Theatre', category: 'off-broadway', openingDate: '2026-05-03', closingDate: '2026-05-31', previewsStartDate: '2026-04-19' };
const nov = { id: 'othello-bedlam-off-broadway-2026', title: 'Othello (Bedlam)', venue: 'West End Theatre', category: 'off-broadway', openingDate: null, previewsStartDate: '2026-11-07', closingDate: '2026-11-29', priorRuns: [{ openingDate: '2026-05-10', closingDate: '2026-05-31', venue: 'West End Theatre' }] };
const other = { id: 'x', title: 'Hamlet', venue: 'West End Theatre', category: 'off-broadway', openingDate: '2026-05-03', closingDate: '2026-05-31' };

test('different title style still links the sibling, but never carries its reviews', () => {
  const r = findPriorRunSiblings(nov, [may, nov]);
  assert.equal(r.length, 1);
  assert.equal(r[0].sibling.id, may.id);
  assert.equal(r[0].carryReviews, false);
});

test('an unrelated title at the same venue and dates is not a sibling', () => {
  assert.equal(findPriorRunSiblings(nov, [other, nov]).length, 0);
});

test('the sibling-held review is returned so the gap row can be tagged prior-run', () => {
  const files = [{ url: 'https://example.com/r', publishDate: '2026-05-04' }];
  const out = collectHousedSiblingFiles(nov, [may, nov], { loadFiles: (id) => (id === may.id ? files : []), isCovered: () => true });
  assert.equal(out.length, 1);
  assert.equal(out[0]._housedOnShowId, may.id);
});
