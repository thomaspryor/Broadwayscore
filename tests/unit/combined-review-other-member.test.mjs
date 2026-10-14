/**
 * BRO-2746: a combined-review file holding a co-member show's review (url names
 * only the other member, text never names this show) is excluded from scoring.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const guards = require('../../scripts/lib/review-guards.js');
const { isCombinedReviewOfOtherMemberOnly, explainExclusion } = guards;

const MONTH = { id: 'a-month-in-the-country-west-end-2026', title: 'A Month in the Country', venue: 'Donmar Warehouse', category: 'west-end', openingDate: '2026-08-28' };
// The 2026-09-02 incident record (text abbreviated, shape as on disk).
const incident = () => ({
  showId: MONTH.id, outletId: 'thestage', outlet: 'The Stage', criticName: 'Sam Marlowe',
  url: 'https://www.thestage.co.uk/reviews/care-review-young-vic-london-alexander-zeldin',
  fullText: '', contentTier: 'excerpt', originalScore: '4/5',
  dtliExcerpt: 'Meticulously, unflashily acted by a faultless ensemble, the minor tragedies of a care home pile up.',
  showScoreExcerpt: 'Meticulously, unflashily acted by a faultless ensemble.',
  isCombinedReview: true, combinedWith: ['care-west-end-2026'],
});

test('the incident fixture is caught and excluded', () => {
  assert.equal(isCombinedReviewOfOtherMemberOnly(incident(), MONTH), true);
  assert.equal(explainExclusion(incident(), MONTH), 'combinedReviewOfOtherMemberOnly');
});

test('a joint article whose url names both shows is kept', () => {
  const d = { ...incident(), url: 'https://www.thestage.co.uk/reviews/care-and-a-month-in-the-country-review' };
  assert.equal(isCombinedReviewOfOtherMemberOnly(d, MONTH), false);
});

test('text naming this show keeps it (genuine joint review)', () => {
  const d = { ...incident(), fullText: 'At the Donmar, A Month in the Country finds Turgenev fresh; meanwhile Care at the Young Vic...' };
  assert.equal(isCombinedReviewOfOtherMemberOnly(d, MONTH), false);
});

test('not a combined review, or url naming no member: not this predicate', () => {
  assert.equal(isCombinedReviewOfOtherMemberOnly({ ...incident(), isCombinedReview: false }, MONTH), false);
  assert.equal(isCombinedReviewOfOtherMemberOnly({ ...incident(), url: 'https://www.thestage.co.uk/reviews/roundup-2026-09' }, MONTH), false);
});

test('a human score or wrongShow clear wins', () => {
  assert.equal(isCombinedReviewOfOtherMemberOnly({ ...incident(), humanReviewScore: 70 }, MONTH), false);
  assert.equal(isCombinedReviewOfOtherMemberOnly({ ...incident(), wrongShowManualClear: true }, MONTH), false);
});

test('revival variants of the same title are not "another member"', () => {
  const d = { ...incident(), url: 'https://x.com/reviews/a-month-in-the-country-2015-review', combinedWith: ['a-month-in-the-country-2015'] };
  assert.equal(isCombinedReviewOfOtherMemberOnly(d, MONTH), false);
});

test('a wrongShowOverride stamped by flag-combined-reviews itself is not a human clear', () => {
  const d = { ...incident(), wrongShowOverride: true, wrongShowOverrideReason: 'flag-combined-reviews.js: URL co-occurs across 2 show dirs — joint review' };
  assert.equal(isCombinedReviewOfOtherMemberOnly(d, MONTH), true);
  const human = { ...incident(), wrongShowOverride: true, wrongShowOverrideReason: 'owner: verified joint review' };
  assert.equal(isCombinedReviewOfOtherMemberOnly(human, MONTH), false);
});

test('url naming this show without its leading article is kept', () => {
  const d = { ...incident(), url: 'https://www.thestage.co.uk/reviews/month-in-the-country-and-care-review' };
  assert.equal(isCombinedReviewOfOtherMemberOnly(d, MONTH), false);
});
