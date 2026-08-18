// Regression lock for isPunctuationFalsePositive(), the second-pass rescue
// audit-aggregator-archive-integrity.js runs after validateRoundupPageTitle
// flags 'page-title-mismatch'. Fixtures are real cases found while fixing
// #1763 (CI Data Validation red: aggregator-archive integrity).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isPunctuationFalsePositive, pageTitleConfirmsShow } = require('./show-matching.js');

test('rescues trailing exclamation-mark titles ("On Your Feet!")', () => {
  assert.equal(
    isPunctuationFalsePositive('ON YOUR FEET Broadway Reviews | Broadway World', 'On Your Feet!'),
    true
  );
});

test('rescues a dotted acronym ("QED" vs "Q.E.D.")', () => {
  assert.equal(isPunctuationFalsePositive('Q.E.D. - Did They Like It?', 'QED'), true);
});

test('rescues a slash-joined title ("Bernhardt/Hamlet")', () => {
  assert.equal(
    isPunctuationFalsePositive('Bernhardt / Hamlet - Did They Like It?', 'Bernhardt/Hamlet'),
    true
  );
});

test('rescues a byline-prefixed subtitle the aggregator drops', () => {
  assert.equal(
    isPunctuationFalsePositive('Show Score | Can I Be Frank? NYC Reviews and Tickets', 'Morgan Bassichis: Can I Be Frank?'),
    true
  );
});

test('does NOT rescue a genuinely different show (wrong-show poisoning)', () => {
  assert.equal(
    isPunctuationFalsePositive('Review Roundup: STEREOPHONIC Opens On Broadway', "Rock 'n' Roll"),
    false
  );
});

test('does NOT rescue a generic aggregator homepage title (soft-404)', () => {
  assert.equal(
    isPunctuationFalsePositive(
      'BroadwayWorld: Latest News, Coverage, Tickets for Broadway and Theatre Around the World',
      'Avenue Q'
    ),
    false
  );
});

// pageTitleConfirmsShow() — used by validate-archive-productions.js to tell
// "DTLI's page doesn't mention this show at all" from "DTLI's single
// per-title page just describes a different revival" (#1763).
test('pageTitleConfirmsShow: confirms a short/numeric title via confidence matcher ("13")', () => {
  assert.equal(pageTitleConfirmsShow('13 - Did They Like It?', '13'), true);
});

test('pageTitleConfirmsShow: confirms a multi-word title with a DTLI suffix', () => {
  assert.equal(pageTitleConfirmsShow('An Act of God - Did They Like It?', 'An Act of God'), true);
});

test('pageTitleConfirmsShow: confirms via the punctuation-FP path ("Fela!")', () => {
  assert.equal(pageTitleConfirmsShow('Fela(2009) - Did They Like It?', 'Fela!'), true);
});

test('pageTitleConfirmsShow: false when the page names a different show entirely', () => {
  assert.equal(pageTitleConfirmsShow('Stereophonic - Did They Like It?', "Rock 'n' Roll"), false);
});

test('pageTitleConfirmsShow: false for an empty/missing page title', () => {
  assert.equal(pageTitleConfirmsShow('', 'Avenue Q'), false);
});
