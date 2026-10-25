import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { isJointCombinedCopy } = require('../../scripts/lib/joint-combined-copy.js');

const URL_ = 'https://lavocedinewyork.com/en/new-york/2026/08/29/three-off-broadway-plays-to-consider-for-end-of-summer-theater-experiences/';
const B = 'benevolent-off-broadway-2026';
const D = 'disruption-off-broadway-2026';
const P = 'the-pass-off-broadway-2026';
const copy = (showId, combinedWith, over = {}) => ({ showId, url: URL_, isCombinedReview: true, combinedWith, ...over });

test('sibling copies of one three-show article are not cross-show dupes', () => {
  const kept = copy(B, [D, P]);
  assert.equal(isJointCombinedCopy(copy(D, [B, P]), D, kept), true);
  assert.equal(isJointCombinedCopy(copy(P, [B, D]), P, kept), true);
});

test('either side naming the other is enough', () => {
  assert.equal(isJointCombinedCopy(copy(P, []), P, copy(B, [P])), true);
  assert.equal(isJointCombinedCopy(copy(P, [B]), P, copy(B, [])), true);
});

test('real contamination still dedups', () => {
  // not flagged combined
  assert.equal(isJointCombinedCopy({ showId: P, url: URL_ }, P, copy(B, [P])), false);
  // different URL
  assert.equal(isJointCombinedCopy(copy(P, [B], { url: URL_ + 'x' }), P, copy(B, [P])), false);
  // combined but neither names the other
  assert.equal(isJointCombinedCopy(copy(P, ['other-show']), P, copy(B, ['third-show'])), false);
  assert.equal(isJointCombinedCopy(null, P, copy(B, [P])), false);
});

test('rebuild dedup consults the joint-copy guard and records combined fields', () => {
  const src = readFileSync(new URL('../../scripts/rebuild-all-reviews.js', import.meta.url), 'utf8');
  assert.match(src, /!isJointCombinedCopy\(data, showId, existing\)/);
  assert.match(src, /crossShowFingerprints\.set\(fp, \{ showId, file, url: data\.url, isCombinedReview: data\.isCombinedReview, combinedWith: data\.combinedWith \}\)/);
});
