/**
 * Love London Love Culture: block the round-ups, keep the original reviews.
 *
 * The whole domain sat in AGGREGATOR_DOMAINS because its "review round-up"
 * posts quote other critics (task #1036). That also dropped its own reviews,
 * e.g. The Last Ship at Drury Lane (BRO-4185, 2026-09-27).
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { isBlockedReviewUrl } = require('../../scripts/lib/domain-filters.js');

test('LLLC original reviews are not blocked', () => {
  for (const url of [
    'https://lovelondonloveculture.com/2026/09/26/review-the-last-ship-theatre-royal-drury-lane/',
    'https://lovelondonloveculture.com/2026/07/28/review-the-importance-of-being-oscar-park-theatre/',
    'https://www.lovelondonloveculture.com/2025/05/21/review-the-comedy-about-spies-noel-coward-theatre',
  ]) assert.strictEqual(isBlockedReviewUrl(url), false, url);
});

test('LLLC round-ups and non-review pages stay blocked', () => {
  for (const url of [
    'https://lovelondonloveculture.com/2026/08/04/review-round-up-the-car-man-sadlers-wells/',
    'https://lovelondonloveculture.com/2026/07/19/review-round-up-the-oresteia-bridge-theatre/',
    'https://lovelondonloveculture.com/2026/09/01/interview-with-a-star/',
    'https://lovelondonloveculture.com/',
  ]) assert.strictEqual(isBlockedReviewUrl(url), true, url);
});
