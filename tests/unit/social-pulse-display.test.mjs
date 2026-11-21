/**
 * shouldShowSentiment contract (task #527, 2026-07-26 credibility fix).
 * Runs in the tsx unit batch (test.yml) — imports src TS directly per the
 * gate-logic precedent (commercial-display.test.mjs).
 *
 * Object-arg signature was added after a /second-opinion review found a
 * positional (opinionSample, positivePct) call would compile cleanly and
 * silently transpose the two fields. These tests lock the object contract
 * and the null-vs-zero semantics it exists to protect.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { shouldShowSentiment, MIN_OPINION_SAMPLE } = await import('../../src/lib/social-pulse-display.ts');

test('positivePct === null (no opinion-bearing posts) never shows', () => {
  assert.equal(shouldShowSentiment({ positivePct: null, opinionSample: 0 }), false);
  assert.equal(shouldShowSentiment({ positivePct: null, opinionSample: null }), false);
  assert.equal(shouldShowSentiment({ positivePct: null }), false);
});

test('positivePct undefined or NaN never shows', () => {
  assert.equal(shouldShowSentiment({ positivePct: undefined, opinionSample: 50 }), false);
  assert.equal(shouldShowSentiment({ positivePct: NaN, opinionSample: 50 }), false);
});

test('opinionSample below MIN_OPINION_SAMPLE suppresses a real percentage', () => {
  assert.equal(shouldShowSentiment({ positivePct: 100, opinionSample: MIN_OPINION_SAMPLE - 1 }), false);
  assert.equal(shouldShowSentiment({ positivePct: 0, opinionSample: 2 }), false);
});

test('opinionSample >= MIN_OPINION_SAMPLE with a real percentage shows', () => {
  assert.equal(shouldShowSentiment({ positivePct: 62, opinionSample: MIN_OPINION_SAMPLE }), true);
  assert.equal(shouldShowSentiment({ positivePct: 0, opinionSample: 50 }), true);
});

test('legacy v2 files with no opinionSample field still show (backward compat)', () => {
  assert.equal(shouldShowSentiment({ positivePct: 45, opinionSample: undefined }), true);
  assert.equal(shouldShowSentiment({ positivePct: 45 }), true);
});

test('a positional-style transposition mistake now reads as a wrong-key diff, not silently', () => {
  // The bug the review caught: shouldShowSentiment(os, p) with positional args
  // compiled cleanly and returned wrong answers. With named fields, the same
  // mistake means writing `{ positivePct: opinionSample, opinionSample: positivePct }`
  // at the call site — a visible swap of the *keys*, not an invisible swap of
  // argument order. Confirm the two values genuinely diverge when confused this way.
  const opinionSample = 2;
  const positivePct = 100;
  const correct = shouldShowSentiment({ positivePct, opinionSample });
  const confused = shouldShowSentiment({ positivePct: opinionSample, opinionSample: positivePct });
  assert.equal(correct, false); // thin sample (2 posts) — hidden
  assert.equal(confused, true); // 2% positive but "100 posts" — would wrongly show
  assert.notEqual(correct, confused);
});

test('non-finite or out-of-range positivePct never shows (corrupt-data floor)', () => {
  assert.equal(shouldShowSentiment({ positivePct: Infinity, opinionSample: 50 }), false);
  assert.equal(shouldShowSentiment({ positivePct: -1, opinionSample: 50 }), false);
  assert.equal(shouldShowSentiment({ positivePct: 101, opinionSample: 50 }), false);
  assert.equal(shouldShowSentiment({ positivePct: 100, opinionSample: 50 }), true);
  assert.equal(shouldShowSentiment({ positivePct: 0, opinionSample: 50 }), true);
});
