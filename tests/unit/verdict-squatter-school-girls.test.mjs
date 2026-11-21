/**
 * BRO-4369: Playbill Verdict's own School Girls page links TheaterMania's
 * "Falls for Jodie" review under "Theatermania (Zachary Stewart)". The file it
 * creates is flagged wrongShow and must not squat the slot against the real
 * School Girls TheaterMania review. Exercises the real predicate (BRO-4956).
 *
 * Run: node --test tests/unit/verdict-squatter-school-girls.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { flaggedSlotSupersededBy } = require('../../scripts/lib/review-slot-guards.js');

const SHOW = {
  id: 'school-girls-or-the-african-mean-girls-play-2026',
  title: 'School Girls; Or, The African Mean Girls Play',
  venue: 'Samuel J. Friedman Theatre', category: 'broadway', openingDate: '2026-09-28',
};
const SQUATTER = {
  wrongShow: true, source: 'playbill-verdict', publishDate: '2026-09-28',
  url: 'https://www.theatermania.com/news/review-in-falls-for-jodie-john-hinckley-jr-makes-a-friend_1855201/',
};
const REAL = 'https://www.theatermania.com/news/review-school-girls-or-the-african-mean-girls-play-brings-80s-fashion-and-ageless-politics-to-broadway_1855224/';

test('real School Girls review supersedes the wrongShow Falls for Jodie squatter', () => {
  assert.equal(flaggedSlotSupersededBy(SQUATTER, { url: REAL, publishDate: '2026-09-29', outletId: 'theatermania', criticNamed: true }, SHOW), true);
  assert.equal(flaggedSlotSupersededBy(SQUATTER, { url: REAL, outletId: 'theatermania', criticNamed: true }, SHOW), true);
});

test('a human-confirmed flag is never superseded', () => {
  assert.equal(flaggedSlotSupersededBy({ ...SQUATTER, humanReviewedWrongProduction: true }, { url: REAL, publishDate: '2026-09-29', outletId: 'theatermania', criticNamed: true }, SHOW), false);
});
