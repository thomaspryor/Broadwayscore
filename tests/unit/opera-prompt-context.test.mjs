/**
 * Regression tests for the opera-aware classifier prompts.
 *
 * Background: scripts/classify-wrong-production.js and classify-wrong-show.js
 * historically used Broadway-theater-tuned prompts ("You are an expert in
 * Broadway theater history"), causing them to mis-flag Met opera reviews as
 * wrong_production or wrong_show. Tristan und Isolde had 13 of 13 reviews
 * auto-flagged at every 6-hour enrichment cron, rescued only by the temporal
 * override at rebuild time.
 *
 * Fix (2026-05-17): both classifiers now inject opera-specific context blocks
 * from scripts/lib/opera-prompt-context.js when the filed show is an opera.
 *
 * Tightened (2026-05-17 ship-check P1-A + P1-B): wording is symmetric to
 * avoid false-negatives on genuine wrong-production opera reviews. These
 * tests now also verify the WRONG_PRODUCTION case explicitly (not just the
 * CORRECT case).
 *
 * See Notion 363637c5-416f-81cc-8240-c48df8b4cfd2.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isOperaShow,
  getOperaWrongProductionContext,
  getOperaWrongShowContext,
} from '../../scripts/lib/opera-prompt-context.js';

test('isOperaShow recognizes type=opera', () => {
  assert.equal(isOperaShow({ type: 'opera' }), true);
  assert.equal(isOperaShow({ type: 'opera', category: 'off-broadway' }), true);
});

test('isOperaShow rejects non-opera and null', () => {
  assert.equal(isOperaShow({ type: 'musical' }), false);
  assert.equal(isOperaShow({ type: 'play' }), false);
  assert.equal(isOperaShow({ type: 'special' }), false);
  assert.equal(isOperaShow({}), false);
  assert.equal(isOperaShow(null), false);
  assert.equal(isOperaShow(undefined), false);
});

test('wrong-production opera context covers BOTH the CORRECT case (other houses) AND the WRONG_PRODUCTION case (different Met run)', () => {
  const ctx = getOperaWrongProductionContext();
  assert.match(ctx, /OPERA CONTEXT/i);
  assert.match(ctx, /Metropolitan Opera/i);
  // CORRECT case: mentions of other opera houses are normal
  assert.match(ctx, /(Royal Opera|La Scala|San Francisco Opera)/i);
  assert.match(ctx, /(other opera|non-Met)/i);
  // WRONG_PRODUCTION case must be explicit, not just "lenient"
  assert.match(ctx, /WRONG_PRODUCTION/);
  assert.match(ctx, /(different Met run|different cast.*conductor|different Met season)/i);
  // The distinction must include a year-mismatch / publishDate cue
  assert.match(ctx, /(year mismatch|year-mismatched|publishDate)/i);
});

test('wrong-production context does NOT contain the discredited "Be lenient" phrasing', () => {
  const ctx = getOperaWrongProductionContext();
  // The original draft said "Be lenient — opera reviews routinely compare..."
  // which stacked with the classifier's existing "lean toward CORRECT on
  // ambiguous" instruction and biased toward false negatives. The ship-check
  // P1-A tightening explicitly removed that phrasing. If a future edit
  // re-introduces it, this assertion fails.
  assert.doesNotMatch(ctx, /\bBe lenient\b/);
});

test('wrong-show opera context preserves the genuine wrong-show signal', () => {
  const ctx = getOperaWrongShowContext();
  assert.match(ctx, /OPERA/);
  assert.match(ctx, /Metropolitan Opera House/i);
  // Must mention the opera vocabulary so the model recognizes valid opera reviews
  assert.match(ctx, /conductor/i);
  assert.match(ctx, /(sopranos|tenors|arias)/i);
  // CORRECT case
  assert.match(ctx, /(CORRECT|do not flag|valid context)/i);
  // WRONG_SHOW case must still be preserved — opera framing does NOT relax it
  assert.match(ctx, /WRONG_SHOW/);
  assert.match(ctx, /(different opera|different show entirely|different title|different composer)/i);
});

test('opera contexts are non-empty distinct strings', () => {
  const wp = getOperaWrongProductionContext();
  const ws = getOperaWrongShowContext();
  assert.ok(wp.length > 400, 'wrong-production context should be substantive (covers both verdicts explicitly)');
  assert.ok(ws.length > 300, 'wrong-show context should be substantive');
  assert.notEqual(wp, ws, 'contexts should be distinct (different classifier purposes)');
});
