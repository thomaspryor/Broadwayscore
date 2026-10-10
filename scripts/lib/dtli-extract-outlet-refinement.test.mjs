/**
 * BRO-226: extract-dtli-reviews.js duplicated the "URL domain resolves to
 * outlet X, prefer the URL" refinement that review-file-writer.js's
 * createOrMergeReviewFile() chokepoint already guards with
 * shouldRefuseAggregatorOutletRefinement(). This script writes via
 * safeWriteReview directly (not through the shared chokepoint), so it needs
 * its own copy of the guard — this test pins that copy.
 *
 * Real corpus regression (found while fixing this): DTLI's "read more" link
 * for bob-fosses-dancin-2023/nytg and patriots-2024/nysr was a broken
 * didtheylikeit.com/wp-admin URL. resolveOutletFromUrl() resolved that to the
 * 'dtli' aggregator outlet, and the un-guarded refinement rewrote the real
 * outletId ('nytg'/'nysr') to 'dtli' — collapsing a real critic's byline into
 * an aggregator record. Verified against the full local DTLI archive
 * (789 HTML files, 4,400 reviews, 2026-08-14): exactly those 2 reviews change
 * outletId with this fix; zero other reviews are affected.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractReviewsFromDTLI } = require('../extract-dtli-reviews.js');

function reviewItemHtml({ outlet, criticName, url, excerpt }) {
  return `
<div class="review-item">
  <div class="review_image"><div>${outlet}</div></div>
  <h2 class="review-item-critic-name">${criticName}</h2>
  <h3 class="review-item-date">January 1, 2024</h3>
  <img alt="BigThumbs_Up" />
  <p class="paragraph">${excerpt}</p>
  <a href="${url}" class="button-pink review-item-button">Read Full Review</a>
</div>`;
}

const LONG_EXCERPT = 'A '.repeat(20) + 'genuinely substantive review excerpt worth keeping.';

function quiet(fn) {
  const warn = console.warn;
  const log = console.log;
  console.warn = () => {};
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.warn = warn;
    console.log = log;
  }
}

test('refuses to launder a real outlet onto an aggregator via a broken read-more link', () => {
  // Mirrors the real bob-fosses-dancin-2023 shape: DTLI labeled the review
  // "New York Theatre Guide" (-> nytg) but the button href is DTLI's own
  // broken wp-admin URL, which resolveOutletFromUrl() resolves to 'dtli'.
  const html = reviewItemHtml({
    outlet: 'New York Theatre Guide',
    criticName: 'Gillian Russo',
    url: 'https://didtheylikeit.com/wp-admin/post-new.php?post_type=shows',
    excerpt: LONG_EXCERPT,
  });
  const reviews = quiet(() => extractReviewsFromDTLI(html, 'bob-fosses-dancin-2023'));
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].outletId, 'nytg', 'must keep the real outlet, not launder onto dtli');
  assert.notEqual(reviews[0].outletId, 'dtli');
});

test('still applies ordinary cross-domain refinement between two real outlets', () => {
  // The case the refinement exists for: DTLI mislabels a real outlet but the
  // URL points to a different real outlet's own domain (ap -> huffpost, the
  // most common real-corpus shape). Neither side is an aggregator, so the
  // URL should still win.
  const html = reviewItemHtml({
    outlet: 'Associated Press',
    criticName: 'Mark Kennedy',
    url: 'http://www.huffingtonpost.com/huff-wires/20120614/us-theater-review-harvey/',
    excerpt: LONG_EXCERPT,
  });
  const reviews = quiet(() => extractReviewsFromDTLI(html, 'harvey-2012'));
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].outletId, 'huffpost', 'ordinary real-outlet refinement must be unaffected');
});

test('leaves a genuine DTLI-native review under dtli untouched', () => {
  // DTLI itself publishing an original review by a named freelance critic —
  // outletRaw IS "Did They Like It" and the URL is DTLI's own domain. The
  // refinement block must not even consider this a mismatch (both sides
  // already resolve to 'dtli'), so it must land exactly where it always did.
  const html = reviewItemHtml({
    outlet: 'Did They Like It',
    criticName: 'Bedatri D.Choudhury',
    url: 'https://didtheylikeit.com/shows/a-strange-loop/review/',
    excerpt: LONG_EXCERPT,
  });
  const reviews = quiet(() => extractReviewsFromDTLI(html, 'a-strange-loop-2022'));
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].outletId, 'dtli');
});

test('does not interfere with genuine aggregator alias refinement (lbo -> london-box-office)', () => {
  const html = reviewItemHtml({
    outlet: 'LBO',
    criticName: 'Stuart King',
    url: 'https://www.londonboxoffice.co.uk/news/post/some-review',
    excerpt: LONG_EXCERPT,
  });
  const reviews = quiet(() => extractReviewsFromDTLI(html, 'some-west-end-show-2026'));
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].outletId, 'london-box-office');
});
