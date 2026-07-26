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

test('object-arg contract prevents positional transposition', () => {
  // The exact bug the review caught: a caller passing (opinionSample, positivePct)
  // by position would silently mean something else. With named fields, swapping
  // the keys in the call below is what it would take to reintroduce the bug —
  // and that's a visible, reviewable diff, not a silent argument-order mistake.
  const thinSample = { positivePct: 100, opinionSample: 2 };
  const wrongOrderEquivalent = { opinionSample: 2, positivePct: 100 };
  assert.equal(shouldShowSentiment(thinSample), shouldShowSentiment(wrongOrderEquivalent));
  assert.equal(shouldShowSentiment(thinSample), false);
});
