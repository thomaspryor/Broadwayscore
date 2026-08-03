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
