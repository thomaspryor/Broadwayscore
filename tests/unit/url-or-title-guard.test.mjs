/**
 * Unit tests for urlOrTitleLooksLikeReview (review-guards.js)
 *
 * Wraps the existing urlLooksLikeReview to ALSO accept a match against the
 * article title/H1, not just the URL slug. Critics often write reviews with
 * creative titles that don't repeat the show name in the URL — Theater Pizzazz
 * Ron Fassler's DoaS review URL is "hes-back-but-has-willy-loman-ever-left-us"
 * with no "death-of-a-salesman" anywhere in the URL. The bare URL guard rejected
 * the legitimate review on opening night.
 *
 * The helper also accepts a `trustedSource` bypass — used for BWW Review Roundup
 * extraction where the manual curation is trusted.
 *
 * Refs: memory/project_doas_opening_night_issues.md issue #6
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { urlOrTitleLooksLikeReview } = require('../../scripts/lib/review-guards.js');

describe('urlOrTitleLooksLikeReview', () => {
  test('plain slug match → true (delegates to urlLooksLikeReview)', () => {
    assert.strictEqual(
      urlOrTitleLooksLikeReview(
        'https://nytimes.com/2026/04/10/theater/death-of-a-salesman-broadway-review.html',
        'Death of a Salesman',
        null
      ),
      true
    );
  });

  test('creative title in URL, articleTitle contains show name → true', () => {
    // Theater Pizzazz Ron Fassler's review of DoaS:
    //   URL: hes-back-but-has-willy-loman-ever-left-us
    //   articleTitle: "He's Back, But Has Willy Loman Ever Left Us? Ron Fassler on Death of a Salesman"
    assert.strictEqual(
      urlOrTitleLooksLikeReview(
        'https://theaterpizzazz.com/hes-back-but-has-willy-loman-ever-left-us/',
        'Death of a Salesman',
        "He's Back, But Has Willy Loman Ever Left Us? Ron Fassler on Death of a Salesman"
      ),
      true
    );
  });

  test('creative URL with no articleTitle and no slug match → false', () => {
    // Without an article title, we can't verify — fall back to the strict slug check.
    assert.strictEqual(
      urlOrTitleLooksLikeReview(
        'https://theaterpizzazz.com/hes-back-but-has-willy-loman-ever-left-us/',
        'Death of a Salesman',
        null
      ),
      false
    );
  });

  test('trustedSource bypass → true regardless of slug or title', () => {
    // BWW Review Roundup curation: trust the human editor.
    assert.strictEqual(
      urlOrTitleLooksLikeReview(
        'https://random-blog.com/some-essay/',
        'Death of a Salesman',
        null,
        { trustedSource: true }
      ),
      true
    );
  });

  test('articleTitle that does NOT contain show name → false', () => {
    // Article about something completely different — should reject.
    assert.strictEqual(
      urlOrTitleLooksLikeReview(
        'https://example.com/random-article/',
        'Death of a Salesman',
        'The 10 Best Restaurants in Brooklyn'
      ),
      false
    );
  });

  test('null URL → false', () => {
    assert.strictEqual(urlOrTitleLooksLikeReview(null, 'Death of a Salesman', null), false);
  });

  test('long-title partial articleTitle match → true (>=50% words for 4+ word titles)', () => {
    // "Cats: The Jellicle Ball" significant words: ["cats", "jellicle", "ball"]
    // (drops "the"). With 3+ words, urlLooksLikeReview requires ALL to match.
    // For 4+ word titles, only 50% are required.
    // Use a 4-word title here so the 50% rule applies.
    // "Death of a Salesman Revival 2026" → significant words: ["death", "salesman", "revival"]
    // articleTitle has "salesman" + "revival" = 2/3 ≈ 67%, > 50% (but length is 3, requires all)
    // Use a longer title:
    const showTitle = 'The Curious Incident of the Dog in the Night-Time';
    // significant words: ["curious", "incident", "dog", "night-time"] (4 words)
    // articleTitle has "curious" + "incident" = 2/4 = 50%, passes
    assert.strictEqual(
      urlOrTitleLooksLikeReview(
        'https://example.com/some-essay/',
        showTitle,
        'A Curious Incident on Stage'
      ),
      true
    );
  });

  test('short title strict match — partial fails', () => {
    // For 1-3 word titles, urlLooksLikeReview requires ALL words to match
    // (prevents Becky Shaw matching Fiona Shaw, etc.).
    assert.strictEqual(
      urlOrTitleLooksLikeReview(
        'https://example.com/willy-loman-essay',
        'Death of a Salesman',
        'A Salesman for Our Times'  // only matches "salesman", not "death" — strict fails
      ),
      false
    );
  });

  test('rejected URL types (tag, author, ticket pages) → false even with title match', () => {
    // The base urlLooksLikeReview rejects /tag/ /author/ /ticket pages.
    // Our wrapper should respect those rejections regardless of articleTitle.
    assert.strictEqual(
      urlOrTitleLooksLikeReview(
        'https://example.com/tag/death-of-a-salesman/',
        'Death of a Salesman',
        'Death of a Salesman tag page'
      ),
      false
    );
  });
});
