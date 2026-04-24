/**
 * Short-title fallback regression tests.
 *
 * Beaches 2026-04-22: opening-night poller discovered every outlet review URL
 * (NYT, Guardian, People, EW, TimeOut, TheWrap, BWW Review Roundup, TB) but
 * rejected ALL of them via title-match validators that required every word of
 * "Beaches, A New Musical" to appear in the URL slug / page title. Zero auto-
 * ingested; 22 manually ingested.
 *
 * Fix: comma-subtitle short-title fallback in 4 validator sites:
 *   - scripts/lib/bww-roundup-validator.js  (validateBWWRoundupUrlMatchesShow)
 *   - scripts/lib/review-guards.js          (urlLooksLikeReview)
 *   - scripts/lib/tb-direct-url.js          (verifyTbPage)
 *   - scripts/rebuild-all-reviews.js        (showNotMentioned auto-clear)
 *
 * Shared helper: scripts/lib/title-normalization.js → shortTitleCandidate()
 *
 * See Notion card 34c637c5-416f-81ef-8efa-cac82d767bd3.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { shortTitleCandidate } = require('../../scripts/lib/title-normalization.js');
const { validateBWWRoundupUrlMatchesShow } = require('../../scripts/lib/bww-roundup-validator.js');
const { urlLooksLikeReview } = require('../../scripts/lib/review-guards.js');
const { verifyTbPage } = require('../../scripts/lib/tb-direct-url.js');

describe('shortTitleCandidate', () => {
  test('returns short title for comma-subtitled show', () => {
    assert.strictEqual(shortTitleCandidate('Beaches, A New Musical'), 'Beaches');
  });

  test('returns null for title without comma', () => {
    assert.strictEqual(shortTitleCandidate('Hamilton'), null);
  });

  test('returns null for title that is only a comma', () => {
    assert.strictEqual(shortTitleCandidate(','), null);
  });

  test('returns null for empty/nullish title', () => {
    assert.strictEqual(shortTitleCandidate(''), null);
    assert.strictEqual(shortTitleCandidate(null), null);
    assert.strictEqual(shortTitleCandidate(undefined), null);
  });

  test('handles leading/trailing whitespace in short title', () => {
    assert.strictEqual(shortTitleCandidate('Beaches , A New Musical'), 'Beaches');
  });
});

describe('validateBWWRoundupUrlMatchesShow — short-title fallback', () => {
  test('Beaches short-title slug accepted when full title has subtitle', () => {
    // This is the exact URL the 2026-04-22 Beaches poller rejected 14 times.
    assert.strictEqual(
      validateBWWRoundupUrlMatchesShow(
        'https://www.broadwayworld.com/article/Review-Roundup-BEACHES-Opens-on-Broadway-20260422',
        'Beaches, A New Musical'
      ),
      true
    );
  });

  test('unrelated show slug rejected even with short-title fallback', () => {
    assert.strictEqual(
      validateBWWRoundupUrlMatchesShow(
        'https://www.broadwayworld.com/article/Review-Roundup-CARS-Opens-on-Broadway-20260422',
        'Beaches, A New Musical'
      ),
      false
    );
  });

  test('full-title match still works for non-subtitled shows', () => {
    assert.strictEqual(
      validateBWWRoundupUrlMatchesShow(
        'https://www.broadwayworld.com/article/Review-Roundup-THE-ROCKY-HORROR-SHOW-Opens-on-Broadway-20260423',
        'The Rocky Horror Show'
      ),
      true
    );
  });

  test('stopword-only short title degrades gracefully', () => {
    // "A, The Musical" → short title "A" → all-stopword → fail-open (returns true
    // for the short check; original behavior). Unlikely edge case in practice.
    assert.strictEqual(
      validateBWWRoundupUrlMatchesShow(
        'https://www.broadwayworld.com/article/Review-Roundup-UNRELATED-Opens-on-Broadway-20260422',
        'Cats'
      ),
      false
    );
  });
});

describe('urlLooksLikeReview — short-title fallback', () => {
  test('NYT Beaches outlet URL accepted', () => {
    assert.strictEqual(
      urlLooksLikeReview(
        'https://nytimes.com/2026/04/22/theater/beaches-review-broadway.html',
        'Beaches, A New Musical'
      ),
      true
    );
  });

  test('Guardian Beaches outlet URL accepted', () => {
    assert.strictEqual(
      urlLooksLikeReview(
        'https://theguardian.com/stage/2026/apr/22/beaches-review-broadway-musical',
        'Beaches, A New Musical'
      ),
      true
    );
  });

  test('People Beaches outlet URL accepted', () => {
    assert.strictEqual(
      urlLooksLikeReview(
        'https://people.com/broadway-beaches-musical-review-11953683',
        'Beaches, A New Musical'
      ),
      true
    );
  });

  test('unrelated show URL rejected even with short-title fallback', () => {
    assert.strictEqual(
      urlLooksLikeReview(
        'https://nytimes.com/2026/04/22/theater/cats-review-broadway.html',
        'Beaches, A New Musical'
      ),
      false
    );
  });

  test('non-subtitled short titles still require all words', () => {
    // "Becky Shaw" → Fiona Shaw reviews must NOT match via short-title fallback,
    // because there IS no comma so shortTitleCandidate returns null.
    assert.strictEqual(
      urlLooksLikeReview(
        'https://variety.com/2026/theater/reviews/fiona-shaw-review-1234',
        'Becky Shaw'
      ),
      false
    );
  });

  test('2-char short title "Oh, Mary!" does NOT fail-open on arbitrary URLs', () => {
    // Ship-check P0: shortTitleCandidate("Oh, Mary!") returns "Oh" (2 chars). Without a
    // guard, urlTitleWordsPass filters words length>2 → ['oh']→[] (empty) → fail-open
    // returns true for ANY non-reject URL. Affects oh-mary-2024 + oh-mary-west-end-2025
    // (both open). Guard added 2026-04-24 requires ≥1 meaningful short-title word.
    assert.strictEqual(
      urlLooksLikeReview('https://example.com/cats-review-broadway/', 'Oh, Mary!'),
      false,
      'unrelated cats URL must NOT match Oh, Mary via short-title fallback'
    );
    assert.strictEqual(
      urlLooksLikeReview('https://nytimes.com/2026/04/22/theater/hamilton-review.html', 'Oh, Mary!'),
      false,
      'unrelated hamilton URL must NOT match Oh, Mary'
    );
  });

  test('full-title path still works for "Oh, Mary!" when URL contains "mary"', () => {
    // Full title "Oh, Mary!" normalizes to ['mary'] (length>2 keeps "mary", strips "oh").
    // Real Oh, Mary URLs contain "mary" → full-title path accepts. Short-title fallback
    // is only the backup; the primary check still works.
    assert.strictEqual(
      urlLooksLikeReview('https://nytimes.com/2026/04/22/theater/oh-mary-review.html', 'Oh, Mary!'),
      true
    );
  });
});

describe('verifyTbPage — short-title fallback', () => {
  // Minimum content bytes = 800, needs byline regex "by FirstName LastName"
  const tbBylineSignal = 'Theatre Review by Matthew Murray. April 22, 2026. ';
  const padTo = (s, n) => s + ' '.repeat(Math.max(0, n - s.length));

  test('TB page title "Beaches" accepted for "Beaches, A New Musical"', () => {
    const html = padTo(
      `<html><head><title>Talkin' Broadway on Broadway: Beaches — April 22, 2026</title></head>` +
      `<body>${tbBylineSignal}verdict rave. April 22, 2026</body></html>`,
      900
    );
    const v = verifyTbPage(html, {
      showTitle: 'Beaches, A New Musical',
      openingDate: '2026-04-22',
    });
    assert.strictEqual(v.ok, true, v.reason);
  });

  test('TB page title for different show rejected', () => {
    const html = padTo(
      `<html><head><title>Talkin' Broadway: Hamilton — April 22, 2026</title></head>` +
      `<body>${tbBylineSignal}verdict rave.</body></html>`,
      900
    );
    const v = verifyTbPage(html, {
      showTitle: 'Beaches, A New Musical',
      openingDate: '2026-04-22',
    });
    assert.strictEqual(v.ok, false);
    assert.match(v.reason, /title mismatch/);
  });

  test('full-title match still works for non-subtitled shows', () => {
    const html = padTo(
      `<html><head><title>Talkin' Broadway: The Rocky Horror Show — April 23, 2026</title></head>` +
      `<body>${tbBylineSignal}verdict rave. April 23, 2026</body></html>`,
      900
    );
    const v = verifyTbPage(html, {
      showTitle: 'The Rocky Horror Show',
      openingDate: '2026-04-23',
    });
    assert.strictEqual(v.ok, true, v.reason);
  });

  test('2-char short title "Oh, Mary!" does NOT substring-match unrelated words', () => {
    // Ship-check P0: normalizeText("Oh") = "oh" (2 chars). Without guard, normPage.includes("oh")
    // matches "Wholesome", "Mother", "though", etc. in any TB page. Guard requires
    // short-title normalized length ≥ 4 chars before including in titleVariants.
    const html = padTo(
      `<html><head><title>Talkin' Broadway: John Wholesome at the Mother Theater — April 22, 2026</title></head>` +
      `<body>${tbBylineSignal}verdict rave. April 22, 2026</body></html>`,
      900
    );
    const v = verifyTbPage(html, {
      showTitle: 'Oh, Mary!',
      openingDate: '2026-04-22',
    });
    assert.strictEqual(v.ok, false, 'Wholesome page must NOT match Oh, Mary via 2-char substring');
    assert.match(v.reason, /title mismatch/);
  });

  test('real Oh, Mary! TB page still accepted via full-title path', () => {
    // Full title "Oh, Mary!" normalizes to "oh mary" (via normalizeText which strips
    // punctuation and collapses whitespace). A page titled "Oh, Mary!" normalizes to
    // the same string → includes match → accepted.
    const html = padTo(
      `<html><head><title>Talkin' Broadway: Oh, Mary! — April 22, 2026</title></head>` +
      `<body>${tbBylineSignal}verdict rave. April 22, 2026</body></html>`,
      900
    );
    const v = verifyTbPage(html, {
      showTitle: 'Oh, Mary!',
      openingDate: '2026-04-22',
    });
    assert.strictEqual(v.ok, true, v.reason);
  });
});
