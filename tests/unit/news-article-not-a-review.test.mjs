/**
 * Regression test for scripts/lib/news-article-detector.js.
 *
 * Task #1323: the Collect pipeline ingested outlet NEWS articles (press
 * releases, "first look"/"the lowdown"/"releases first listen" pieces) as
 * contentTier=complete with NO rejectionReason. Unflagged, they read as
 * FOUND to getFoundOutletIds() (scripts/lib/found-outlet-ids.js), which
 * skips rejectionReason='not_a_review' but has no signal for these files —
 * so SERP/gap discovery never looked for the outlets' REAL reviews.
 *
 * Root cause: files whose source URL is on an aggregator/listing domain
 * (isBlockedReviewUrl) are filtered out of isScoreable() before the LLM
 * ensemble (ensemble-scoreability-check) ever sees them, so rejectionReason
 * is never stamped — the file sits unflagged indefinitely. This detector is
 * a heuristic backstop for that specific class: URL /news/ path + a
 * promotional headline phrase + no star rating.
 *
 * Fixtures below are modeled on 3 real death-note-the-musical-west-end-2026
 * review-text files (west-end-best-friend, londontheatredirect,
 * westendtheatre) found unflagged in the corpus on 2026-08-12.
 *
 * Run: node --test tests/unit/news-article-not-a-review.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { detectNewsArticle } = require('../../scripts/lib/news-article-detector.js');

// Modeled on west-end-best-friend--unknown.json (death-note-the-musical-west-end-2026).
const WEST_END_BEST_FRIEND = {
  outletId: 'west-end-best-friend',
  url: 'https://www.westendbestfriend.co.uk/news/death-note-adds-an-extra-performance-and-gives-an-exclusive-first-listen',
  fullText: 'DEATH NOTE adds extra performance and gives an exclusive first listen News Jul 28 Written By News Desk '
    + 'Ahead of the first preview of DEATH NOTE: THE MUSICAL this Thursday 30 July at the Barbican, producers have '
    + 'released an exclusive first listen to three songs from the musical via their website, giving fans their first '
    + 'chance to hear the soaring score by Emmy, Grammy and Tony-Award nominated composer Frank Wildhorn.',
  contentTier: 'complete',
};

// Modeled on londontheatredirect--london-theatre-direct-limited.json.
const LONDONTHEATREDIRECT = {
  outletId: 'londontheatredirect',
  url: 'https://www.londontheatredirect.com/news/the-lowdown-on-death-note-the-musical-at-the-barbican',
  fullText: 'The Lowdown on Death Note: The Musical at the Barbican Published on 5 August 2026 What is it? '
    + 'Death Note – The Musical is a musical version of the early 2000s manga created by Tsugumi Ohba and Takeshi '
    + 'Obata about the sharp-as-a-pin high school student, Light Yagami.',
  contentTier: 'complete',
};

// Modeled on westendtheatre--julianna-barnaby.json — the one file with ZERO
// rejection fields at all (never seen by ensemble-scoreability-check because
// westendtheatre.com sits on the aggregator/listing block list).
const WESTENDTHEATRE_NEWS = {
  outletId: 'westendtheatre',
  criticName: 'Julianna Barnaby',
  url: 'https://www.westendtheatre.com/360914/news/death-note-the-musical-releases-first-listen/',
  fullText: 'Death Note: The Musical releases first listen and adds extra performance ahead of Barbican opening '
    + 'Ahead of its opening at the Barbican this Thursday 30 July, the producers of Death Note: The Musical have '
    + 'released an exclusive first listen to three songs from the show.',
  contentTier: 'complete',
};

// A real review from the SAME outlet, hosted under a /news/reviews/ path —
// must NOT be misclassified just because the URL contains "/news/".
const WESTENDTHEATRE_REAL_REVIEW = {
  outletId: 'westendtheatre',
  criticName: 'Julianna Barnaby',
  url: 'https://www.westendtheatre.com/359033/news/reviews/the-truth-apollo-reviews/',
  fullText: 'The Truth at the Apollo Theatre review: a taut, blackly comic thriller. Director Stephen Unwin keeps '
    + 'the tension crackling throughout this brilliantly acted revival. 4 out of 5 stars. The cast is uniformly '
    + 'excellent, and the staging is superb from curtain up to the final, devastating twist.',
  contentTier: 'complete',
};

// A real review with no /news/ path at all.
const ORDINARY_REVIEW = {
  outletId: 'nytimes',
  criticName: 'Jesse Green',
  url: 'https://www.nytimes.com/2026/07/30/theater/death-note-the-musical-review.html',
  fullText: 'Death Note: The Musical, which opened Thursday at the Barbican, is a handsomely mounted but dramatically '
    + 'inert affair. Frank Wildhorn\'s score aims for menace and mostly finds bombast instead. Director Stephen '
    + 'Whitson stages the show with visual flair, but the storytelling drags.',
  contentTier: 'complete',
};

describe('detectNewsArticle — outlet NEWS articles vs real reviews', () => {
  test('west-end-best-friend "adds an extra performance" news piece classifies as a news article', () => {
    const result = detectNewsArticle(WEST_END_BEST_FRIEND);
    assert.equal(result.isNewsArticle, true);
    assert.ok(result.reasons.includes('url-path:/news/'));
  });

  test('londontheatredirect "the lowdown on" feature classifies as a news article', () => {
    const result = detectNewsArticle(LONDONTHEATREDIRECT);
    assert.equal(result.isNewsArticle, true);
  });

  test('westendtheatre "releases first listen" news piece (the never-classified file) classifies as a news article', () => {
    const result = detectNewsArticle(WESTENDTHEATRE_NEWS);
    assert.equal(result.isNewsArticle, true);
  });

  test('a real review under the same outlet\'s /news/reviews/ path is NOT classified as a news article', () => {
    const result = detectNewsArticle(WESTENDTHEATRE_REAL_REVIEW);
    assert.equal(result.isNewsArticle, false);
  });

  test('an ordinary review with no /news/ URL segment is NOT classified as a news article', () => {
    const result = detectNewsArticle(ORDINARY_REVIEW);
    assert.equal(result.isNewsArticle, false);
  });

  test('missing/empty data does not throw', () => {
    assert.equal(detectNewsArticle(null).isNewsArticle, false);
    assert.equal(detectNewsArticle({}).isNewsArticle, false);
  });
});
