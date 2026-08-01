/**
 * excerpt-validation regression tests — tour-contamination other-show carve-out.
 *
 * Bug (2026-08-01, the-comedy-about-spies-west-end-2026): the Times' Dominic
 * Maxwell review opens with a comparison lede — "Noises Off is on tour on its
 * umpteenth revival; Fawlty Towers is back in London soon before going on
 * tour." — before getting to The Comedy About Spies. isTourReviewExcerpt had
 * no other-show awareness, so that lede tripped the "on tour" pattern and the
 * review was excluded from reviews.json (skippedTourContamination) even
 * though it never describes ITSELF as touring.
 *
 * Per CLAUDE.md rule 15 this require()s the real function — no logic copied.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isTourReviewExcerpt } = require('./excerpt-validation.js');

const CURRENT = {
  currentShowId: 'the-comedy-about-spies-west-end-2026',
  currentShowTitle: 'The Comedy About Spies',
};

test('comparison lede mentioning a different show on tour is not flagged as contamination', () => {
  const excerpt = "Noises Off is on tour on its umpteenth revival; Fawlty Towers is back in "
    + "London soon before going on tour. The Play That Goes Wrong is in its 11th year in the "
    + "West End. I was much more of a fan of Magic Goes Wrong... So I was greasing my chuckle "
    + "chops for their similar-sounding new one, The Comedy About Spies.";
  const result = isTourReviewExcerpt(excerpt, CURRENT);
  assert.equal(result.isTourReview, false);
  assert.equal(result.otherShowComparison, true);
  assert.equal(result.mentionedTitle, 'Noises Off');
});

test('without context, the same excerpt still trips the tour pattern (no regression to the raw signal)', () => {
  const excerpt = "Noises Off is on tour on its umpteenth revival.";
  const result = isTourReviewExcerpt(excerpt);
  assert.equal(result.isTourReview, true);
});

test('a genuine touring-production review of THIS show is still flagged (no false negative)', () => {
  const excerpt = "This touring production of The Comedy About Spies is currently on tour, "
    + "playing regional houses across the UK before a West End transfer.";
  const result = isTourReviewExcerpt(excerpt, CURRENT);
  assert.equal(result.isTourReview, true);
});

test('other-show mention well outside the proximity window does not suppress a genuine signal', () => {
  const excerpt = "Fans of Noises Off, a very different sort of farce entirely, will find plenty else to enjoy "
    + "in London this season, from small fringe houses to the big commercial West End transfers everyone "
    + "keeps talking about at length in every publication. Meanwhile, this touring production of "
    + "The Comedy About Spies is currently on tour around regional theatres.";
  const result = isTourReviewExcerpt(excerpt, CURRENT);
  assert.equal(result.isTourReview, true);
});
