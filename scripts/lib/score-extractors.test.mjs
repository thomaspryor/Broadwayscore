import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractScore } = require('./score-extractors.js');

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
function guardianStarHtml(filledCount, emptyCount, { filledClass = 'dcr-1we7dfv', emptyClass = 'dcr-d88drm' } = {}) {
  const css = `<style>.${filledClass}{display:flex;background-color:var(--star-rating-background);}` +
    `.${emptyClass}{display:flex;background-color:var(--star-rating-empty-background);}</style>`;
  const filled = `<div class="${filledClass}"><svg></svg></div>`.repeat(filledCount);
  const empty = `<div class="${emptyClass}"><svg></svg></div>`.repeat(emptyCount);
  return `${css}<h1>A Play</h1>${filled}${empty}`;
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

test('one-minute-critic: rating-image filename is a fallback when alt text is stripped', () => {
  const html = '<img data-src="https://1minutecritic.com/wp-content/uploads/2026/04/4-stars.png" class="lazyload">';
  const result = extractScore(html, '', 'one-minute-critic');
  assert.ok(result);
  assert.equal(result.originalScore, '4/5');
  assert.equal(result.source, 'omc-star-rating');
});

// NY Post regression coverage: css-stars must count real DOM elements, not
// CSS rule definitions that mention the same class names (e.g.
// ".rating__star--filled svg{fill:...}" inside a <style> block).
test('nypost: css-stars ignores <style> block rules and counts only real star elements', () => {
  const html = '<style>.rating__star--filled svg{fill:red}.rating__star--empty svg{fill:grey}</style>' +
    '<div class="rating__stars">' +
    '<div class="rating__star rating__star--filled"></div>' +
    '<div class="rating__star rating__star--filled"></div>' +
    '<div class="rating__star rating__star--empty"></div>' +
    '<div class="rating__star rating__star--empty"></div>' +
    '</div>';
  const result = extractScore(html, '', 'nypost');
  assert.ok(result);
  assert.equal(result.originalScore, '2/4 stars');
  assert.equal(result.source, 'css-stars');
});
