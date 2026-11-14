/**
 * BRO-1351: SERP URL-matcher rejects transfer-record review URLs.
 *
 * discoverCorrectUrl()'s candidate loop in scripts/lib/url-discovery.js
 * gates every SERP result on `titleHasShow || urlHasShow` before accepting
 * it. That gate used to be raw substring matching against the show's
 * lowercased title and a showId-derived "shortSlug"
 * (review.showId minus the trailing -YYYY, dashes for spaces) — e.g. for
 * dad-dont-read-this-off-broadway-2026 that slug is
 * "dad-dont-read-this-off-broadway", which bakes in the category suffix
 * ("-off-broadway") that no real review URL or headline ever contains.
 *
 * Confirmed live on gather-reviews.js for dad-dont-read-this-off-broadway-2026
 * (0/85 outlets discovered): the real NYT review of the show's declared
 * priorRun turned up as a lone SERP result and was still rejected —
 *   titleHasShow: "dad don't read this" is not a substring of the real
 *     headline "'Dad, Don't Read This' Review: ..." (comma after "Dad").
 *   urlHasShow: neither "dad-don't-read-this" (apostrophe literal from the
 *     slugified title) nor "dad-dont-read-this-off-broadway" (the
 *     showId-derived shortSlug) is a substring of the real URL
 *     ".../dad-dont-read-this-review.html".
 *
 * Fix: route titleHasShow/urlHasShow through the existing
 * urlLooksLikeReview() token matcher (already used by the slug guard later
 * in the same loop) against the CANONICAL title instead — it tokenizes on
 * word boundaries (so punctuation next to a title word no longer breaks the
 * match) and already carries the comma-subtitle shortTitleCandidate
 * fallback from the Beaches incident (title-short-fallback.test.mjs).
 *
 * This was never the priorRuns/date-window bug — that part shipped in
 * task #758 (commit 8a05196008f) and already places same-year prior runs
 * inside the SERP query window; both runs here are in calendar year 2026.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { urlLooksLikeReview } = require('../../scripts/lib/review-guards.js');

describe('SERP URL-matcher accepts transfer-record review URLs (BRO-1351)', () => {
  const showTitle = "Dad Don't Read This";

  test('real NYT title for the earlier priorRun is accepted (comma-adjacent word)', () => {
    const title = "'Dad, Don't Read This' Review: Girls Just Wanna Have Fun - The New York Times".toLowerCase();
    assert.equal(urlLooksLikeReview(title, showTitle), true);
  });

  test('real NYT review URL for the earlier priorRun is accepted', () => {
    const url = 'https://www.nytimes.com/2026/05/17/theater/dad-dont-read-this-review.html';
    assert.equal(urlLooksLikeReview(url, showTitle), true);
  });

  test('showId-suffixed slug is NOT required — a plain review URL with no category suffix matches', () => {
    // Old behavior additionally accepted urlLower.includes(shortSlug), where
    // shortSlug = "dad-dont-read-this-off-broadway" (from the showId). No
    // real review URL contains that suffix, so it could never actually help
    // — asserting the fix doesn't depend on it either.
    const url = 'https://vulture.com/article/dad-dont-read-this-theater-review.html';
    assert.equal(urlLooksLikeReview(url, showTitle), true);
  });

  test('a wrong-show candidate is still rejected', () => {
    const url = 'https://nytimes.com/2026/01/01/theater/hamilton-review.html';
    assert.equal(urlLooksLikeReview(url, showTitle), false);
  });

  test('comma-subtitled show still matches its outlet URL (no regression from the word-boundary widening)', () => {
    // Beaches incident (title-short-fallback.test.mjs) — must stay green:
    // widening wordMatch's boundary punctuation set must not weaken the
    // existing comma-subtitle short-title fallback path.
    assert.equal(
      urlLooksLikeReview(
        'https://theatermania.com/off-broadway/reviews/beaches-review_92345.html',
        'Beaches, A New Musical'
      ),
      true
    );
  });
});
