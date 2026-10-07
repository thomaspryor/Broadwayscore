// Regression tests for isStaleCvPromotedWrongProduction — the self-heal that
// clears one-directional CV-promoted wrongProduction flags when the current
// contentVerification record says wrongProduction=false.
//
// Per feedback_test_extraction_pattern.md: require the real function.
//
// Incident (2026-06-15): Romeo & Juliet (Shakespeare in the Park) NY Stage
// Review (Roma Torre, 79) was excluded by a stale CV-promoted wrongProduction
// flag even though contentVerification.wrongProduction was false (high
// confidence). CV promotion only ever SET the flag, never cleared it when a
// later re-verification disagreed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isStaleCvPromotedWrongProduction } = require('../../scripts/lib/review-guards.js');

const stale = (over = {}) => ({
  wrongProduction: true,
  wrongProductionReason: 'CV-promoted: This is a legitimate review of the Delacorte production...',
  contentVerification: { wrongProduction: false, wrongArticle: false, confidence: 'high', verifiedBy: 'llm:claude-haiku' },
  // Independent corroboration: a confident ensemble score (mirrors the real
  // nysr--roma-torre incident, score 79 medium).
  llmScore: { score: 79, confidence: 'medium' },
  ...over,
});

test('clears a stale CV-promoted flag when current CV says wrongProduction=false at high confidence', () => {
  assert.equal(isStaleCvPromotedWrongProduction(stale(), false), true);
  // CV-low-but-strong-signal provenance is also CV-sourced
  assert.equal(isStaleCvPromotedWrongProduction(stale({ wrongProductionReason: 'CV-low-but-strong-signal: ...' }), false), true);
});

test('requires HIGH CV confidence — medium is not enough to undo a flag', () => {
  assert.equal(isStaleCvPromotedWrongProduction(stale({ contentVerification: { wrongProduction: false, wrongArticle: false, confidence: 'medium' } }), false), false);
});

test('does NOT clear flags from non-CV provenance (date guard, ensemble, tour)', () => {
  assert.equal(isStaleCvPromotedWrongProduction(stale({ wrongProductionReason: 'Date guard: 400d before opening' }), false), false);
  assert.equal(isStaleCvPromotedWrongProduction(stale({ wrongProductionReason: 'Ensemble rejected: wrong_production' }), false), false);
  assert.equal(isStaleCvPromotedWrongProduction(stale({ wrongProductionReason: '' }), false), false);
});

test('does NOT clear when the current CV still says wrongProduction=true', () => {
  assert.equal(isStaleCvPromotedWrongProduction(stale({ contentVerification: { wrongProduction: true, confidence: 'high' } }), false), false);
});

test('does NOT clear on low-confidence or missing CV', () => {
  assert.equal(isStaleCvPromotedWrongProduction(stale({ contentVerification: { wrongProduction: false, confidence: 'low' } }), false), false);
  assert.equal(isStaleCvPromotedWrongProduction(stale({ contentVerification: null }), false), false);
  assert.equal(isStaleCvPromotedWrongProduction(stale({ contentVerification: {} }), false), false);
});

test('does NOT clear when the CV is stale (text changed after verification)', () => {
  assert.equal(isStaleCvPromotedWrongProduction(stale(), true), false);
});

test('does NOT clear when a stronger sibling guard or human decision is present', () => {
  assert.equal(isStaleCvPromotedWrongProduction(stale({ wrongShow: true }), false), false);
  assert.equal(isStaleCvPromotedWrongProduction(stale({ rejectionReason: 'wrong_show' }), false), false);
  assert.equal(isStaleCvPromotedWrongProduction(stale({ wrongProductionManualClear: true }), false), false);
  assert.equal(isStaleCvPromotedWrongProduction(stale({ wrongProductionOverride: true }), false), false);
  assert.equal(isStaleCvPromotedWrongProduction(stale({ humanReviewedWrongProduction: false }), false), false);
});

test('ignores files that are not flagged wrongProduction', () => {
  assert.equal(isStaleCvPromotedWrongProduction(stale({ wrongProduction: false }), false), false);
  assert.equal(isStaleCvPromotedWrongProduction(null, false), false);
});

test('requires independent corroboration — no/low-confidence ensemble score is not cleared', () => {
  // Titus Andronicus OB 2026 class: a misfiled wrong-show review whose later CV
  // wrongly says wrongProduction=false but which carries NO ensemble score.
  assert.equal(isStaleCvPromotedWrongProduction(stale({ llmScore: undefined }), false), false);
  assert.equal(isStaleCvPromotedWrongProduction(stale({ llmScore: { score: 79, confidence: 'low' } }), false), false);
  assert.equal(isStaleCvPromotedWrongProduction(stale({ llmScore: { confidence: 'high' } }), false), false); // no numeric score
});

test('does NOT clear when current CV says wrongArticle (wrong show)', () => {
  assert.equal(isStaleCvPromotedWrongProduction(stale({ contentVerification: { wrongProduction: false, wrongArticle: true, confidence: 'high' } }), false), false);
});
