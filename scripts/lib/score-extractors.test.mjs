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
