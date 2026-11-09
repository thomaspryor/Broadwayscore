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
const TEXT = 'Benevolent is first. Disruption is second. The Pass is third, and we leave the theater unhappy.';
const copy = (showId, combinedWith, over = {}) => ({ showId, url: URL_, isCombinedReview: true, combinedWith, fullText: TEXT, ...over });
const SHOW = { [B]: { title: 'Benevolent' }, [D]: { title: 'Disruption' }, [P]: { title: 'The Pass' } };

test('sibling copies of one three-show article are not cross-show dupes', () => {
  const kept = [copy(B, [D, P])];
  assert.equal(isJointCombinedCopy(copy(D, [B, P]), D, kept, SHOW[D]), true);
  assert.equal(isJointCombinedCopy(copy(P, [B, D]), P, kept, SHOW[P]), true);
});

test('a later copy may match any stored sibling, not only the first', () => {
  const kept = [copy(B, [D]), copy(D, [B, P])];
  assert.equal(isJointCombinedCopy(copy(P, [D]), P, kept, SHOW[P]), true);
});

test('real contamination still dedups', () => {
  const kept = [copy(B, [P])];
  assert.equal(isJointCombinedCopy({ ...copy(P, [B]), isCombinedReview: false }, P, kept, SHOW[P]), false, 'not flagged combined');
  assert.equal(isJointCombinedCopy(copy(P, [B], { url: URL_ + '?res=2' }), P, kept, SHOW[P]), false, 'query string differs');
  assert.equal(isJointCombinedCopy(copy(P, [B]), P, [copy(B, [])], SHOW[P]), true, 'one-sided naming is how the flagger left Benevolent');
  assert.equal(isJointCombinedCopy(copy(P, []), P, [copy(B, [])], SHOW[P]), false, 'neither names the other');
  assert.equal(isJointCombinedCopy(copy(P, ['other-show']), P, [copy(B, ['third-show'])], SHOW[P]), false, 'neither names the other (lists non-empty)');
  assert.equal(isJointCombinedCopy(copy(P, [B], { fullText: 'A review of an entirely different musical about cats.' }), P, kept, SHOW[P]), false, 'text never mentions this show');
  assert.equal(isJointCombinedCopy(copy(P, [B]), P, kept, undefined), false, 'no show record');
  assert.equal(isJointCombinedCopy(null, P, kept, SHOW[P]), false);
});

test('short titles (Red, SIX, Art) count when written as a proper noun twice (BRO-7077)', () => {
  const R = 'red-off-broadway-2026';
  const red = (fullText) => copy(R, [B], { fullText });
  const kept = [copy(B, [R])];
  assert.equal(isJointCombinedCopy(red('Benevolent is first. Red is gorgeous and RED lingers.'), R, kept, { title: 'Red' }), true);
  assert.equal(isJointCombinedCopy(red('Benevolent is first. SIX rocks. SIX again.'), R, kept, { title: 'SIX' }), true);
  assert.equal(isJointCombinedCopy(red('Benevolent is first, then Art. Art is next.'), R, kept, { title: 'Art' }), true);
  assert.equal(isJointCombinedCopy(red('Benevolent is first, then a play in red light.'), R, kept, { title: 'Red' }), false, 'prose red never counts');
  assert.equal(isJointCombinedCopy(red('Benevolent is first. Redemption follows. Redder.'), R, kept, { title: 'Red' }), false, 'substring never counts');
  assert.equal(isJointCombinedCopy(red('Benevolent is first. Big surprise in act two.'), R, kept, { title: 'Big' }), false, 'one sentence-start hit is not enough');
  assert.equal(isJointCombinedCopy(red('Benevolent opened March 13 and runs to May 13.'), R, kept, { title: '13' }), false, 'number titles never count');
  assert.equal(isJointCombinedCopy(copy(R, [], { fullText: 'Art is next. Art again.' }), R, [copy(B, ['x'])], { title: 'Art' }), false, 'still needs the combinedWith link');
});

test('rebuild dedup consults the joint-copy guard', () => {
  const src = readFileSync(new URL('../../scripts/rebuild-all-reviews.js', import.meta.url), 'utf8');
  assert.match(src, /isJointCombinedCopy\(data, showId, existing\.copies \|\| \[existing\], showById\[showId\]\)/);
});
