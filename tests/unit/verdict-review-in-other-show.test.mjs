// BRO-7077 (BRO-4369): the Playbill Verdict anchor sweep took a TheaterMania
// "Review: In Falls for Jodie, ..." sidebar link as School Girls' review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { reviewSlugNamesDifferentShow } = require('../../scripts/lib/review-normalization.js');
const T = 'School Girls; Or, The African Mean Girls Play';
const opts = { reviewInOnly: true };

test('review-in slug naming another show is rejected', () => {
  assert.equal(reviewSlugNamesDifferentShow('https://www.theatermania.com/news/review-in-falls-for-jodie-john-hinckley-jr-makes-a-friend_1855201/', T, opts), true);
});
test('review-in slug naming this show is kept', () => {
  assert.equal(reviewSlugNamesDifferentShow('https://www.theatermania.com/news/review-in-school-girls-or-the-african-mean-girls-play-jocelyn-bioh-returns_1855300/', T, opts), false);
});
test('trailing -review creative slug is not judged in reviewInOnly mode', () => {
  assert.equal(reviewSlugNamesDifferentShow('https://www.bloomberg.com/opinion/taymor-s-dream-review', T, opts), false);
});
test('default mode keeps its trailing -review behaviour', () => {
  assert.equal(reviewSlugNamesDifferentShow('https://example.com/hamilton-review-x', T), true);
});
