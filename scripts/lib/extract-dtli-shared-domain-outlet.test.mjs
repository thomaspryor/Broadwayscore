/**
 * #1524: extract-dtli-reviews.js's URL-preferred outlet refinement (BRO-226,
 * task #653) had no protection against shared-domain outlet collisions — e.g.
 * a correctly-labeled "Sunday Telegraph" review whose URL is on
 * telegraph.co.uk (both outlets share that domain in the registry) would get
 * silently relabeled to "telegraph", destroying the Sunday Telegraph
 * attribution. gather-reviews.js's own copy of this refinement already got
 * this fix (task #1506, commit 5bb63a17cc0) via outletOwnsUrlDomain(); this
 * test pins the same fix ported into extract-dtli-reviews.js.
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

test('(a) does not overwrite a shared-domain edition label with its sibling outlet', () => {
  // Sunday Telegraph and The Telegraph both resolve to telegraph.co.uk in the
  // registry (a real domain collision — resolveOutletFromUrl arbitrarily picks
  // 'telegraph' as the primary owner). Without the outletOwnsUrlDomain guard,
  // a correctly-labeled Sunday Telegraph review would get relabeled 'telegraph'
  // just because its own domain happens to collide with a sibling edition.
  const html = reviewItemHtml({
    outlet: 'Sunday Telegraph',
    criticName: 'Dominic Cavendish',
    url: 'https://www.telegraph.co.uk/theatre/what-to-see/some-west-end-show-review/',
    excerpt: LONG_EXCERPT,
  });
  const reviews = quiet(() => extractReviewsFromDTLI(html, 'some-west-end-show-2026'));
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].outletId, 'sunday-telegraph', 'shared-domain edition label must survive, not collapse onto the sibling outlet');
});

test('(b) still refuses to launder a real outlet onto an aggregator via a broken read-more link (BRO-226 unaffected)', () => {
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

test('(c) still applies ordinary cross-domain refinement between two genuinely different real outlets', () => {
  // Two real outlets, no domain overlap — the URL should still win.
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
