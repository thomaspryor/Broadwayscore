import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractScore, extractNYPostScore } = require('./score-extractors.js');

// KNOWN_STAR_OUTLETS fallthrough — combined multi-show roundup columns.
// Card #935: sylvia-off-west-end-2026's Guardian review was a "week in
// theatre" column rating THREE shows (Phaedra ★★★★★, Sylvia ★★★, Standing at
// the Sky's Edge ★★★★). The old logic took the FIRST anchored star group
// found in the last-15%-of-text zone — Phaedra's 5 stars — and attached it to
// Sylvia's review instead of Sylvia's own 3 stars.
const COMBINED_ROUNDUP_TEXT =
  'Some opening paragraph about the shows in this week\'s roundup column. '.repeat(20) +
  'Star ratings (out of five) Phaedra ★★★★★ Sylvia ★★★ ' +
  'Standing at the Sky’s Edge ★★★★ Phaedra is at the Lyttelton, until 8 April.';

test('single anchored star match: unchanged single-show behavior', () => {
  const text = 'A wonderful night at the theatre. '.repeat(30) + '★★★★ out of five stars.';
  const result = extractScore('', text, 'guardian');
  assert.ok(result, 'should extract a score');
  assert.equal(result.normalizedScore, 80);
  assert.equal(result.source, 'unicode-stars-fallthrough');
});

test('combined multi-show roundup WITHOUT showTitle: abstains rather than guessing', () => {
  const result = extractScore('', COMBINED_ROUNDUP_TEXT, 'guardian');
  assert.equal(result, null, 'ambiguous multi-show rating list must not guess the first match');
});

test('combined multi-show roundup WITH showTitle: picks the show\'s own rating, not the first one', () => {
  const result = extractScore('', COMBINED_ROUNDUP_TEXT, 'guardian', 'Sylvia');
  assert.ok(result, 'should resolve Sylvia\'s own rating');
  assert.equal(result.originalScore, '3/5 stars');
  assert.equal(result.normalizedScore, 60, 'Sylvia was rated 3 stars, not Phaedra\'s 5');
});

test('combined multi-show roundup WITH a non-matching showTitle: abstains', () => {
  const result = extractScore('', COMBINED_ROUNDUP_TEXT, 'guardian', 'Some Other Show');
  assert.equal(result, null, 'no anchored group names this show — must not guess');
});

// The Reviews Hub publishes its own rating as a labelled percentage. The
// markup form ("number rating" element) was the ONLY form the extractor
// understood, so a url-ingested review — where fullText is stored and `html`
// is empty — silently lost its rating and fell through to LLM scoring or to
// no score at all. Measured on the live corpus: 336 Reviews Hub files, 3 of
// them carrying a rating the extractor could not see.
const RH_TEXT_TAIL =
  ' Runs until 10 October 2026 The Reviews Hub Star Rating 40 % 40% ' +
  'Struggles to hit the right notes Reviews Hub membership';
const RH_BODY = 'A long review of the production goes here. '.repeat(30);

test('reviews hub: labelled percentage is read from TEXT when html is empty', () => {
  const result = extractScore('', RH_BODY + RH_TEXT_TAIL, 'thereviewshub', 'Holy Fool');
  assert.ok(result, 'url-ingested Reviews Hub review must not lose its published rating');
  assert.equal(result.normalizedScore, 40);
  assert.equal(result.originalScore, '40%');
  assert.equal(
    result.source,
    'reviewshub-percentage',
    'must reuse the source already in OUTLET_VERIFIED_SOURCES, or the rebuild discards it'
  );
});

test('reviews hub: the html markup form still wins and is unchanged', () => {
  const html = '<div class="number rating">80 <span>%</span></div>';
  const result = extractScore(html, RH_BODY, 'thereviewshub', 'Some Show');
  assert.ok(result, 'markup path must keep working');
  assert.equal(result.normalizedScore, 80);
  assert.equal(result.source, 'reviewshub-percentage');
});

test('reviews hub: a bare percentage in prose does NOT become a rating', () => {
  const text = RH_BODY + ' The venue reported that 40 % of seats were sold on press night.';
  const result = extractScore('', text, 'thereviewshub', 'Some Show');
  assert.equal(result, null, 'fallback must anchor on the outlet rating label, not any percentage');
});

test('reviews hub: out-of-range labelled percentage is rejected', () => {
  const text = RH_BODY + ' The Reviews Hub Star Rating 5 % 5% Dire';
  const result = extractScore('', text, 'thereviewshub', 'Some Show');
  assert.equal(result, null, 'below the 10-100 band the markup path already enforces');
});

// Adversarial review (Codex, 2026-09-05) raised the roundup/sidebar case: the
// outlet extractors never receive showTitle, so a body carrying two different
// labelled ratings has no way to pick the right one. Abstain, matching the
// COMBINED_ROUNDUP idiom above.
test('reviews hub: two DIFFERENT labelled ratings in one body -> abstains', () => {
  const text = RH_BODY +
    ' The Reviews Hub Star Rating 40 % 40% Struggles to hit the right notes' +
    ' Related review The Reviews Hub Star Rating 90 % 90% A triumph';
  const result = extractScore('', text, 'thereviewshub', 'Holy Fool');
  assert.equal(result, null, 'ambiguous multi-rating body must not take the first match');
});

test('reviews hub: the SAME rating repeated is not ambiguous and still resolves', () => {
  const text = RH_BODY +
    ' The Reviews Hub Star Rating 40 % 40% Struggles' +
    ' ... The Reviews Hub Star Rating 40 % again in the footer';
  const result = extractScore('', text, 'thereviewshub', 'Holy Fool');
  assert.ok(result, 'a repeated identical rating is the same rating, not a conflict');
  assert.equal(result.normalizedScore, 40);
});

// The outlet's real heading carries a colon ("The Reviews Hub Star Rating:").
// A second reviewer caught that the first regex missed it; measured on the
// corpus, 1 of the 15 bodies carrying the label uses the colon form
// (midnight-at-the-never-get-west-end-2026), and its published 60% was being
// left unasserted against an LLM value of 56.
test('reviews hub: colon form of the heading is read', () => {
  const text = RH_BODY + ' The Reviews Hub Star Rating: 60 % 60% Insubstantial';
  const result = extractScore('', text, 'thereviewshub', 'Midnight at the Never Get');
  assert.ok(result, 'the published colon-form rating must not be missed');
  assert.equal(result.normalizedScore, 60);
  assert.equal(result.source, 'reviewshub-percentage');
});

// BRO-919: Guardian's star widget is rendered as 5 SVG <div>s whose class
// names are Emotion (CSS-in-JS) hashes that rotate on every Guardian
// frontend deploy — "dcr-1we7dfv" today, something else next deploy. The
// old extractor only looked for class="rating-N"/"stars-N" or JSON-LD,
// neither of which Guardian ever emits, so it always returned null for a
// real Guardian review. The fix resolves which hash is "filled" vs "empty"
// at read time via the CSS custom property each is bound to
// (--star-rating-background / --star-rating-empty-background), which is
// stable even though the hash isn't. Shape verified live against real
// Guardian HTML (both a 2026 and a 2024 review URL) 2026-09-15.
function guardianStarWidget(filledCount, emptyCount, filledClass, emptyClass) {
  const filled = `<div class="${filledClass}"><svg></svg></div>`.repeat(filledCount);
  const empty = `<div class="${emptyClass}"><svg></svg></div>`.repeat(emptyCount);
  return filled + empty;
}

function guardianStarHtml(filledCount, emptyCount, { filledClass = 'dcr-1we7dfv', emptyClass = 'dcr-d88drm' } = {}) {
  const css = `<style>.${filledClass}{display:flex;background-color:var(--star-rating-background);}` +
    `.${emptyClass}{display:flex;background-color:var(--star-rating-empty-background);}</style>`;
  const widget = guardianStarWidget(filledCount, emptyCount, filledClass, emptyClass);
  return `${css}<div data-gu-name="headline"><h1>A Play</h1>${widget}</div>`;
}

test('guardian: SVG star widget resolves filled/empty via CSS custom property, not a hardcoded hash', () => {
  const html = guardianStarHtml(3, 2);
  const result = extractScore(html, '', 'guardian');
  assert.ok(result, 'should extract a score from the SVG star widget');
  assert.equal(result.originalScore, '3/5 stars');
  assert.equal(result.normalizedScore, 60);
  assert.equal(result.source, 'guardian-star-svg');
});

test('guardian: SVG star widget with different generated hashes still resolves (next-deploy safety)', () => {
  const html = guardianStarHtml(4, 1, { filledClass: 'dcr-zzq99x', emptyClass: 'dcr-abcd12' });
  const result = extractScore(html, '', 'guardian');
  assert.ok(result, 'must not depend on a specific hardcoded class hash');
  assert.equal(result.originalScore, '4/5 stars');
  assert.equal(result.normalizedScore, 80);
});

test('guardian: a non-review page (no star-rating CSS vars at all) does not false-positive', () => {
  const html = '<style>.dcr-xyz{color:red;}</style><h1>Some unrelated news article</h1><p>Body text.</p>';
  const result = extractScore(html, 'Some unrelated news article body text.', 'guardian');
  assert.equal(result, null, 'articles without the star-rating component must not match');
});

// Adversarial review (Codex, 2026-09-15): a "related reviews" teaser card
// elsewhere on the same article page reuses the SAME Emotion class hashes
// as the main widget (Guardian hashes by style content, not by instance).
// Without scoping the element COUNT to the headline block, a far-away
// teaser widget would sum into this review's total and either produce a
// wrong score or a >5 total. This locks in that the count stays scoped.
test('guardian: an unrelated widget far from the headline block is not counted into this review\'s total', () => {
  const css = '<style>.dcr-1we7dfv{display:flex;background-color:var(--star-rating-background);}' +
    '.dcr-d88drm{display:flex;background-color:var(--star-rating-empty-background);}</style>';
  const ownWidget = `<div data-gu-name="headline"><h1>A Play</h1>${guardianStarWidget(3, 2, 'dcr-1we7dfv', 'dcr-d88drm')}</div>`;
  const farAwayTeaser = 'x'.repeat(9000) + guardianStarWidget(5, 0, 'dcr-1we7dfv', 'dcr-d88drm');
  const result = extractScore(css + ownWidget + farAwayTeaser, '', 'guardian');
  assert.ok(result, 'the review\'s own widget must still resolve');
  assert.equal(result.originalScore, '3/5 stars', 'must read the headline widget, not sum in the far-away teaser');
});

// Requiring total === 5 (not <=5) means a widget that undercounts one icon
// (e.g. an icon that fails to match either class) abstains instead of
// silently inflating the score with a smaller denominator (3/3 vs 3/5).
test('guardian: a widget that does not total exactly 5 abstains rather than inflating the score', () => {
  const html = guardianStarHtml(3, 1); // only 4 total icons, not 5
  const result = extractScore(html, '', 'guardian');
  assert.equal(result, null, 'a short total must not be treated as a smaller-scale rating');
});

test('guardian: OUTLET_VERIFIED_SOURCES includes the new source name (rebuild trust gate)', () => {
  const { OUTLET_VERIFIED_SOURCES } = require('./score-extractors.js');
  assert.ok(
    OUTLET_VERIFIED_SOURCES.has('guardian-star-svg'),
    'a source name extractGuardianScore emits but getBestScore() does not trust is a silent-discard bug'
  );
});

// BRO-919: 1 Minute Critic changed its rating-image alt text at some point
// in 2026 — old reviews use "1 minute critic N-star rating", but a review
// collected 2026-04-16 (the-fear-of-13) used just "N star review" with no
// outlet-name prefix, which the old extractor's single regex never matched.
test('one-minute-critic: legacy alt-text template ("1 minute critic N-star rating") still works', () => {
  const html = '<img alt="1 minute critic 3-star rating" src="rating.png">';
  const result = extractScore(html, '', 'one-minute-critic');
  assert.ok(result);
  assert.equal(result.originalScore, '3/5');
  assert.equal(result.source, 'omc-alt-text');
});

test('one-minute-critic: current alt-text template ("N star review") is now recognized', () => {
  const html = '<img data-src="https://1minutecritic.com/wp-content/uploads/2026/04/3-stars.png" alt="3 star review" class="lazyload">';
  const result = extractScore(html, '', 'one-minute-critic');
  assert.ok(result, 'the 2026 template must not be missed');
  assert.equal(result.originalScore, '3/5');
  assert.equal(result.normalizedScore, 60);
  assert.equal(result.source, 'omc-alt-text');
});

test('one-minute-critic: current alt-text template is also read from TEXT when html is empty', () => {
  // Some pipelines store an HTML fragment (not plain text) in fullText —
  // same rationale as pattern 1's html-or-text fallback above.
  const result = extractScore('', '<img alt="4 star review">', 'one-minute-critic');
  assert.ok(result);
  assert.equal(result.originalScore, '4/5');
  assert.equal(result.source, 'omc-alt-text');
});

// Adversarial review (Codex, 2026-09-15): a rating-image filename fallback
// ("N-stars.png" in the URL) was here originally and was removed — matching
// a score out of a URL is the "extract metadata from URLs" anti-pattern
// this project's data rules forbid. The filename alone, with no alt text,
// must not produce a score.
test('one-minute-critic: a rating-image filename with no alt text does NOT produce a score', () => {
  const html = '<img data-src="https://1minutecritic.com/wp-content/uploads/2026/04/4-stars.png" class="lazyload">';
  const result = extractScore(html, '', 'one-minute-critic');
  assert.equal(result, null, 'must not extract a rating from URL/filename structure alone');
});

// BRO-922: NY Post CSS stars selector grabs sidebar widget, inflating the score.
// Root cause: extractNYPostScore originally scoped star-counting to the review
// widget's own container (3ea7e7d5d32, the Dog Day Afternoon postmortem fix), but a
// same-day follow-up (fc2d78f12ab) accidentally dropped that scoping while fixing an
// unrelated bug (CSS class DEFINITIONS in <style> blocks being miscounted as stars).
// Both fixes are combined below: strip <style> blocks, AND scope to the first
// inline-module--review widget's own bounded window only.
//
// Real NY Post markup: each star is a <div class="rating__star rating__star--{kind}">
// wrapping an inline <style> block (CSS custom properties) plus an SVG.
function starDiv(kind) {
  return `<div class="rating__star rating__star--${kind}"><style>.review-block-star{--x:#000}</style><svg></svg></div>`;
}

function reviewWidget(filled, half, empty, title = 'THE FEAR OF 13') {
  const stars = [
    ...Array(filled).fill('filled'),
    ...Array(half).fill('half'),
    ...Array(empty).fill('empty'),
  ].map(starDiv).join('');
  return `<div class="inline-module inline-module--review alignleft">
    <div class="inline-module__inner">
      <span class="inline-module--review__eyebrow">Theater review</span>
      <h2 class="inline-module--review__title">${title}</h2>
      <div class="rating"><div class="rating__stars">${stars}</div></div>
    </div>
  </div>`;
}

// The page-wide stylesheet NY Post ships alongside every widget repeats the same
// class names as CSS selector text, which a naive (unscoped) regex would also count.
const NYPOST_PAGE_STYLESHEET = `<style>
.inline-module--review .rating .rating__star--filled svg{fill:var(--x)}
.inline-module--review .rating .rating__star--half svg{fill:url(#half-gradient)}
</style>`;

test('extractNYPostScore: real review with 2/4 filled stars (Fear of 13 fixture, BRO-922 acceptance)', () => {
  const html = `<html><body>
    <div class="single__content entry-content">${reviewWidget(2, 0, 2)}</div>
    ${NYPOST_PAGE_STYLESHEET}
  </body></html>`;
  const result = extractNYPostScore(html, '');
  assert.deepEqual(result, {
    originalScore: '2/4 stars',
    normalizedScore: 50,
    source: 'css-stars',
  });
});

test('extractNYPostScore: half star counts as 0.5', () => {
  const html = `<div class="single__content entry-content">${reviewWidget(3, 1, 0)}</div>${NYPOST_PAGE_STYLESHEET}`;
  const result = extractNYPostScore(html, '');
  assert.equal(result.originalScore, '3.5/4 stars');
  assert.equal(result.normalizedScore, 88); // Math.round(3.5/4*100)
});

test('extractNYPostScore: CSS class DEFINITIONS in <style> blocks are not counted as stars', () => {
  // No actual DOM star elements anywhere on the page — only the stylesheet mentions
  // rating__star--filled/half as selector text (the original Dog Day Afternoon bug:
  // 1.5 stars inflated purely from CSS text, not real elements).
  const html = `<html><body>${NYPOST_PAGE_STYLESHEET}</body></html>`;
  assert.equal(extractNYPostScore(html, ''), null);
});

test('extractNYPostScore: BRO-922 — sidebar/recirc widget immediately adjacent must NOT contribute stars', () => {
  // The real review widget (2 filled/2 empty = 2/4) appears first. A "Related Stories"
  // recirc module immediately follows in the same page, reusing the exact same
  // rating__stars markup for a DIFFERENT show's rating (4 filled = 4/4) — deliberately
  // placed with NO padding between the two widgets, so this proves isolation comes from
  // the real DOM boundary (the `</div></div>` that closes rating__stars + rating), not
  // from the two widgets merely being far apart on the page.
  // Without scoping, a page-wide count would read 2 + 4 = 6 filled stars (out of range,
  // would abstain) or, with a fixed-size window instead of a DOM boundary, could still
  // spill into the second widget depending on window size.
  const realReview = reviewWidget(2, 0, 2, 'THE FEAR OF 13');
  const sidebarRecirc = reviewWidget(4, 0, 0, 'SOME OTHER SHOW');
  const html = `<html><body>
    <div class="single__content entry-content">${realReview}</div>
    <aside class="related-stories">${sidebarRecirc}</aside>
    ${NYPOST_PAGE_STYLESHEET}
  </body></html>`;
  const result = extractNYPostScore(html, '');
  assert.deepEqual(result, {
    originalScore: '2/4 stars',
    normalizedScore: 50,
    source: 'css-stars',
  });
});

test('extractNYPostScore: does not truncate mid-widget when unrelated markup precedes the close boundary', () => {
  // Codex adversarial review (BRO-922): a fixed character window could truncate a
  // widget mid-star, silently under-counting. Insert a large unrelated <div> BEFORE
  // the widget's own closing `</div></div>`, forced well past where an old 6000-char
  // window would have cut off — the DOM-boundary match must still find the widget's
  // real close, not some earlier `</div></div>` pair inside the inserted filler.
  const filler = '<div class="filler">' + 'x'.repeat(6800) + '</div>';
  const html = `<div class="rating"><div class="rating__stars">${starDiv('filled')}${starDiv('filled')}${starDiv('filled')}${filler}</div></div>`;
  const result = extractNYPostScore(html, '');
  assert.ok(result, 'must still find the real widget close beyond a naive fixed window');
  assert.equal(result.originalScore, '3/4 stars');
});

test('extractNYPostScore: falls back to letter grade when no CSS star widget present', () => {
  const html = '<div class="entry-content">no stars here</div>';
  const text = 'Grade: B';
  const result = extractNYPostScore(html, text);
  assert.equal(result.originalScore, 'B');
  assert.equal(result.source, 'letter-grade');
});

test('extractNYPostScore: no widget, no grade, no numeric stars → null (no full-HTML fallback)', () => {
  const html = '<div class="entry-content">Just a plain review with no rating markers.</div>';
  assert.equal(extractNYPostScore(html, 'Just a plain review with no rating markers.'), null);
});

test('The Stage star SVGs are ignored on a /news/ page (sidebar ratings belong to other reviews)', () => {
  const { extractUKStarRating } = require('./score-extractors.js');
  const stars = '<div class="StarRating x"><img src="/stageStar.svg"><img src="/stageStar.svg"><img src="/stageStar.svg"><img src="/stageStar.svg"><img src="/stageNoStar.svg"></div>';
  assert.equal(extractUKStarRating('<link rel="canonical" href="https://www.thestage.co.uk/news/kiss-of-the-spider-woman-to-be-revived-at-curve">' + stars, ''), null);
  assert.equal(extractUKStarRating('<link href="https://thestage.co.uk/news/x" rel="canonical">' + stars, ''), null, 'href before rel, no www');
  assert.equal(extractUKStarRating("<meta content='https://www.thestage.co.uk/news/x' property='og:url'>" + stars, ''), null, 'content before property, single quotes');
  const review = extractUKStarRating('<link rel="canonical" href="https://www.thestage.co.uk/reviews/night-city-review">' + stars, '');
  assert.equal(review.originalScore, '4/5 stars');
});
