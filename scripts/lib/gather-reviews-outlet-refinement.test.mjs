/**
 * BRO-226 cousin (task #1506): gather-reviews.js's own extractDTLIReviews()
 * had no URL-based outlet refinement at all (unlike scripts/extract-dtli-reviews.js,
 * which duplicated the refinement but omitted the guard). This test pins the
 * refinement now added to extractDTLIReviews() and the aggregator-refinement
 * guard (shouldRefuseAggregatorOutletRefinement) that protects it — same
 * predicate the review-file-writer.js chokepoint and extract-dtli-reviews.js
 * (BRO-226) use, applied at gather-reviews.js's own DTLI extraction site.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractDTLIReviews } = require('../gather-reviews.js');

function reviewItemHtml({ outlet, criticName, url, excerpt }) {
  // The extractor's block regex is a lazy match that terminates on the next
  // review-item, </section>, or the modal-breakdown div — it needs one of
  // those sentinels to close the match, so a lone fixture must supply one.
  return `
<div class="review-item">
  <div class="review_image"><div>${outlet}</div></div>
  <h2 class="review-item-critic-name">${criticName}</h2>
  <h3 class="review-item-date">January 1, 2024</h3>
  <img alt="BigThumbs_Up" />
  <p class="paragraph">${excerpt}</p>
  <a href="${url}" class="button-pink review-item-button">Read Full Review</a>
</div>
</section>`;
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
  // DTLI labels the review "New York Theatre Guide" (-> nytg) but the button
  // href is DTLI's own broken wp-admin URL, which resolveOutletFromUrl()
  // resolves to the 'dtli' aggregator outlet.
  const html = reviewItemHtml({
    outlet: 'New York Theatre Guide',
    criticName: 'Gillian Russo',
    url: 'https://didtheylikeit.com/wp-admin/post-new.php?post_type=shows',
    excerpt: LONG_EXCERPT,
  });
  const reviews = quiet(() => extractDTLIReviews(html, 'bob-fosses-dancin-2023', 'https://didtheylikeit.com/shows/bob-fosses-dancin/', 'Bob Fosse\'s Dancin\''));
  assert.equal(reviews.length, 1);
  // extractDTLIReviews() slugifies the DTLI label text directly (it does not
  // canonicalize through the outlet registry the way extract-dtli-reviews.js
  // does) — the invariant under test is that it must NOT be laundered onto
  // the aggregator's own outletId, not that it matches the registry's canonical id.
  assert.equal(reviews[0].outletId, 'new-york-theatre-guide', 'must keep the DTLI label-derived outlet, not launder onto dtli');
  assert.notEqual(reviews[0].outletId, 'dtli');
});

test('still applies ordinary cross-domain refinement between two real outlets', () => {
  // DTLI mislabels a real outlet but the URL points to a different real
  // outlet's own domain — neither side is an aggregator, so the URL should win.
  const html = reviewItemHtml({
    outlet: 'Associated Press',
    criticName: 'Mark Kennedy',
    url: 'http://www.huffingtonpost.com/huff-wires/20120614/us-theater-review-harvey/',
    excerpt: LONG_EXCERPT,
  });
  const reviews = quiet(() => extractDTLIReviews(html, 'harvey-2012', 'https://didtheylikeit.com/shows/harvey/', 'Harvey'));
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].outletId, 'huffpost', 'ordinary real-outlet refinement must be unaffected');
});

test('leaves a genuine DTLI-native review under dtli untouched', () => {
  // outletRaw IS "Did They Like It" and the URL is DTLI's own domain. The
  // slugified label ('did-they-like-it') already legitimately owns
  // didtheylikeit.com per the registry (outletOwnsUrlDomain), so refinement
  // correctly no-ops rather than rewriting it to the canonical 'dtli' id —
  // that canonicalization happens downstream via normalizeOutlet() at write
  // time (createReviewFile), not in this extractor.
  const html = reviewItemHtml({
    outlet: 'Did They Like It',
    criticName: 'Bedatri D.Choudhury',
    url: 'https://didtheylikeit.com/shows/a-strange-loop/review/',
    excerpt: LONG_EXCERPT,
  });
  const reviews = quiet(() => extractDTLIReviews(html, 'a-strange-loop-2022', 'https://didtheylikeit.com/shows/a-strange-loop/', 'A Strange Loop'));
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].outletId, 'did-they-like-it');
});

test('does not interfere with a genuine aggregator alias that already owns its own domain', () => {
  // 'LBO' slugifies to 'lbo', which already owns londonboxoffice.co.uk per the
  // registry — refinement correctly no-ops (no genuine mismatch to correct).
  const html = reviewItemHtml({
    outlet: 'LBO',
    criticName: 'Stuart King',
    url: 'https://www.londonboxoffice.co.uk/news/post/some-review',
    excerpt: LONG_EXCERPT,
  });
  const reviews = quiet(() => extractDTLIReviews(html, 'some-west-end-show-2026', 'https://didtheylikeit.com/shows/some-west-end-show/', 'Some West End Show'));
  const primary = reviews.find((r) => r.criticName === 'Stuart King');
  assert.ok(primary, 'block-parser review must be present');
  assert.equal(primary.outletId, 'lbo');
});

test('applies refinement between two DIFFERENT aggregator outlets (exemption branch, not just the no-op branch)', () => {
  // The prior "genuine aggregator alias" tests above both short-circuit at
  // outletOwnsUrlDomain() before shouldRefuseAggregatorOutletRefinement() is
  // ever called, so they don't exercise the guard's "current outlet is
  // ALSO an aggregator" exemption (AGGREGATOR_OUTLET_IDS.has(normCurrent) ->
  // refuse=false) — only its no-op-because-domain-owned path. This case
  // forces that branch: 'dtli' does not own londonboxoffice.co.uk
  // (outletOwnsUrlDomain is false, so refinement proceeds), and the guard
  // must still not refuse since 'dtli' itself is an aggregator outlet.
  const html = reviewItemHtml({
    outlet: 'DTLI',
    criticName: 'Aggregator Cross Critic',
    url: 'https://www.londonboxoffice.co.uk/news/post/some-west-end-show-review',
    excerpt: LONG_EXCERPT,
  });
  const reviews = quiet(() => extractDTLIReviews(html, 'some-west-end-show-2026', 'https://didtheylikeit.com/shows/some-west-end-show/', 'Some West End Show'));
  const primary = reviews.find((r) => r.criticName === 'Aggregator Cross Critic');
  assert.ok(primary, 'block-parser review must be present');
  assert.equal(primary.outletId, 'london-box-office', 'aggregator-to-aggregator refinement must still apply (not refused)');
});

test('does not overwrite a shared-domain edition label with its sibling outlet', () => {
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
  const reviews = quiet(() => extractDTLIReviews(html, 'some-west-end-show-2026', 'https://didtheylikeit.com/shows/some-west-end-show/', 'Some West End Show'));
  // The block-parser review (identified by its named critic) is what this
  // refinement step governs. Method 2's domain supplement separately walks
  // every outbound anchor and can add its own stub for the same URL under a
  // different outletId (a pre-existing, out-of-scope gap in that helper) —
  // not asserted on here.
  const primary = reviews.find((r) => r.criticName === 'Dominic Cavendish');
  assert.ok(primary, 'block-parser review must be present');
  assert.equal(primary.outletId, 'sunday-telegraph', 'shared-domain edition label must survive, not collapse onto the sibling outlet');
});

test('does not relabel the outlet from a URL that gets rejected as belonging to a different show', () => {
  // DTLI labels the review "Associated Press" but the button href is a stale/
  // cross-show HuffPost link whose slug doesn't match this show's title — the
  // existing urlLooksLikeReview() guard nulls the URL. Refinement must run
  // AFTER that check (using the validated reviewUrl, not the raw urlMatch) so
  // a URL that's about to be discarded can't still relabel the outlet.
  const html = reviewItemHtml({
    outlet: 'Associated Press',
    criticName: 'Mark Kennedy',
    url: 'http://www.huffingtonpost.com/huff-wires/20120614/us-theater-review-totally-different-show/',
    excerpt: LONG_EXCERPT,
  });
  const reviews = quiet(() => extractDTLIReviews(html, 'harvey-2012', 'https://didtheylikeit.com/shows/harvey/', 'Harvey'));
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].url, null, 'sanity check: the cross-show URL must have been rejected');
  assert.equal(reviews[0].outletId, 'associated-press', 'a URL rejected as belonging to another show must not relabel the outlet');
});

test('ordinary happy path: label already matches the URL-derived outlet, no refinement fires', () => {
  // NOT a fill-if-empty case — extractDTLIReviews() requires outletMatch to
  // proceed at all (blocks with no parseable outlet label are skipped
  // entirely, see the "no outlet match" continue above); it never fills a
  // missing label. This just confirms the common case (label and URL agree)
  // passes straight through unaffected by the new refinement guard.
  const html = reviewItemHtml({
    outlet: 'Vulture',
    criticName: 'Sara Holdren',
    url: 'https://www.vulture.com/article/some-review.html',
    excerpt: LONG_EXCERPT,
  });
  const reviews = quiet(() => extractDTLIReviews(html, 'some-show-2026', 'https://didtheylikeit.com/shows/some-show/', 'Some Show'));
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].outletId, 'vulture');
});
