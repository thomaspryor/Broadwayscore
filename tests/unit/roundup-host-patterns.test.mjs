/**
 * BRO-2849: bestoftheatre.co.uk and britishtheatre.com review round-up posts
 * were being ingested and SCORED as ordinary reviews.
 *
 * Both hosts publish posts that summarise the other critics and print THEIR
 * average as the post's own rating:
 *   the-story-west-end-2026/bestoftheatre--maria-boot.json     -> originalRating "3.1/5"
 *     (the stated mean of eight other outlets), assignedScore 62, onto a show
 *     whose critic score was 59.85 over 18 reviews
 *   jesus-christ-superstar-west-end-2026/british-theatre--unknown.json
 *     -> byline "Editorial Staff", assignedScore 78, LIVE in reviews.json
 *
 * WHY THE MAP ENTRY ALONE IS NOT THE FIX (this was the original, wrong plan):
 * isRoundupPageAsReview() returns early on `!isRoundupUrl(url).isRoundup`
 * BEFORE it consults ROUNDUP_HOST_OUTLETS. isRoundupUrl is a list of per-host
 * regexes and never reads that map, so registering a host without adding a URL
 * pattern is completely inert. Both halves are required, and these tests fail
 * if either is reverted.
 *
 * The patterns are deliberately HOST-SCOPED. A bare /review-roundup/ match on
 * any host would be wrong: 168 corpus URLs contain "round-up" on other hosts,
 * including legitimately-included named-critic reviews, and the standing NOTE
 * in isRoundupUrl forbids exactly that. Measured over the whole corpus, this
 * change flips 4 of 37,230 files and leaves the other 168 roundup-shaped URLs
 * untouched.
 *
 * Run: node --test tests/unit/roundup-host-patterns.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isRoundupUrl, isRoundupPageAsReview } = require('../../scripts/lib/review-guards.js');

const BOT = 'https://www.bestoftheatre.co.uk/blog/post/review-roundup-the-story-national-theatre';
const BT = 'https://www.britishtheatre.com/posts/jesus-christ-superstar-palladium-review-round-up';

describe('bestoftheatre round-up posts', () => {
  test('the round-up URL is recognised', () => {
    assert.equal(isRoundupUrl(BOT).isRoundup, true);
  });

  test('page-as-review: the host outlet posting its own round-up is excluded', () => {
    assert.equal(isRoundupPageAsReview({ url: BOT, outletId: 'bestoftheatre' }), true);
  });

  test('sourced-from: a DIFFERENT outlet at that URL stays includable', () => {
    // A review discovered via a round-up but attributed to a real critic and
    // outlet is an original review. This is the case the standing NOTE in
    // isRoundupUrl protects, and the reason the host map is keyed by outletId.
    assert.equal(isRoundupPageAsReview({ url: BOT, outletId: 'times-uk' }), false);
  });

  test('a non-round-up post on the same host is untouched', () => {
    assert.equal(
      isRoundupUrl('https://www.bestoftheatre.co.uk/blog/post/first-look-at-the-story').isRoundup,
      false
    );
  });
});

describe('britishtheatre round-up posts', () => {
  test('the round-up URL is recognised', () => {
    assert.equal(isRoundupUrl(BT).isRoundup, true);
  });

  test('page-as-review: the host outlet posting its own round-up is excluded', () => {
    assert.equal(isRoundupPageAsReview({ url: BT, outletId: 'british-theatre' }), true);
  });

  test('a real britishtheatre review is NOT caught', () => {
    // back-to-the-future-west-end-2021/british-theatre--douglas-mayo.json is a
    // genuine review on this host and must stay includable — verified against
    // the corpus, its verdict is unchanged by this pattern.
    assert.equal(
      isRoundupUrl('https://www.britishtheatre.com/posts/back-to-the-future-review-adelphi').isRoundup,
      false
    );
  });
});

describe('the patterns stay host-scoped', () => {
  test('a round-up-shaped path on an unregistered host is NOT matched', () => {
    // theatrely.com publishes named-critic reviews at round-up-shaped URLs and
    // they are legitimately included today. A host-independent match drops them.
    assert.equal(
      isRoundupUrl('https://www.theatrely.com/post/gender-trouble-the-pass-hungry-women-review-roundup').isRoundup,
      false
    );
  });

  test('"round-up" appearing only in a query string is NOT matched', () => {
    assert.equal(
      isRoundupUrl('https://www.ft.com/content/abc123?from=Review-Roundup-THE-RIVER').isRoundup,
      false
    );
  });
});
