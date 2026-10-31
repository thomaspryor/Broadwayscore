/**
 * Regression test for content-quality.js classifyContentTier wrongProduction gate.
 *
 * Bug: rebuild-all-reviews.js has a contentTier safety-net that calls classifyContentTier
 * BEFORE the wrongProduction auto-clears run later in the same pass. When an earlier guard
 * (e.g. pre-opening, cross-market) sets wrongProduction=true on an allowEarlyDate=true review,
 * the safety-net sees wrongProduction=true, writes contentTier='invalid' to disk, and the
 * later auto-clear flips wrongProduction=false but never re-runs the classifier. Result:
 * reviews with allowEarlyDate/wrongProductionAutoCleared/etc. stayed stuck at 'invalid'.
 *
 * Fix: classifyContentTier now treats wrongProduction=true as effectively-cleared when any
 * of the standard clear-signaling flags are set.
 *
 * Also adds a wrongShow gate (previously missing — wrongShow=true reviews could flip to
 * 'excerpt' or 'complete' based on fullText length).
 *
 * Per CLAUDE.md §15: require() the real function; never duplicate logic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { classifyContentTier } = require(path.join(__dirname, '..', '..', 'scripts', 'lib', 'content-quality.js'));

const REAL_REVIEW_BODY = [
  'The production at the Majestic Theatre opens with a striking overture. The lead actors',
  'bring emotional depth to every scene, and the direction is notably restrained, letting',
  'the book and the score carry most of the weight. The second act features a stunning',
  'set-piece that rivals any of the recent Broadway revivals — lighting, costumes, and',
  'choreography all in service of a single emotional beat. The ensemble work is tight,',
  'the musical transitions are seamless, and the final moments of the show land with',
  'unexpected power. This is the kind of revival that reminds the audience why the',
  'original text has endured. A rare production that earns every ovation it receives.',
].join(' ').repeat(2);

test('classifyContentTier: wrongProduction=true + allowEarlyDate=true → NOT invalid', () => {
  const review = {
    fullText: REAL_REVIEW_BODY,
    textStatus: 'complete',
    wrongProduction: true,          // flagged by an earlier rebuild guard
    allowEarlyDate: true,            // auto-clear will flip wrongProduction→false later
  };
  const result = classifyContentTier(review);
  assert.notEqual(result.contentTier, 'invalid',
    `expected non-invalid tier, got ${result.contentTier} (${result.tierReason})`);
});

test('classifyContentTier: wrongProduction=true + wrongProductionAutoCleared → NOT invalid', () => {
  const review = {
    fullText: REAL_REVIEW_BODY,
    textStatus: 'complete',
    wrongProduction: true,
    wrongProductionAutoCleared: 'rebuild: allowEarlyDate bypasses wrongProduction',
  };
  const result = classifyContentTier(review);
  assert.notEqual(result.contentTier, 'invalid',
    `expected non-invalid tier, got ${result.contentTier} (${result.tierReason})`);
});

test('classifyContentTier: wrongProduction=true + wrongProductionManualClear → NOT invalid', () => {
  const review = {
    fullText: REAL_REVIEW_BODY,
    textStatus: 'complete',
    wrongProduction: true,
    wrongProductionManualClear: true,
  };
  const result = classifyContentTier(review);
  assert.notEqual(result.contentTier, 'invalid',
    `expected non-invalid tier, got ${result.contentTier} (${result.tierReason})`);
});

test('classifyContentTier: wrongProduction=true + humanReviewedWrongProduction=false → NOT invalid', () => {
  const review = {
    fullText: REAL_REVIEW_BODY,
    textStatus: 'complete',
    wrongProduction: true,
    humanReviewedWrongProduction: false,
  };
  const result = classifyContentTier(review);
  assert.notEqual(result.contentTier, 'invalid',
    `expected non-invalid tier, got ${result.contentTier} (${result.tierReason})`);
});

test('classifyContentTier: wrongProduction=true with NO clear flags → INVALID (preserved)', () => {
  const review = {
    fullText: REAL_REVIEW_BODY,
    textStatus: 'complete',
    wrongProduction: true,
    // no allowEarlyDate, no clears
  };
  const result = classifyContentTier(review);
  assert.equal(result.contentTier, 'invalid',
    'wrongProduction with no clears must remain invalid');
  assert.equal(result.tierReason, 'Wrong production');
});

test('classifyContentTier: wrongShow=true → INVALID with tierReason=Wrong show', () => {
  const review = {
    fullText: REAL_REVIEW_BODY,
    textStatus: 'complete',
    wrongShow: true,
    wrongShowReason: 'Cross-show URL collision (revival)',
  };
  const result = classifyContentTier(review);
  assert.equal(result.contentTier, 'invalid');
  assert.equal(result.tierReason, 'Wrong show');
});

test('classifyContentTier: wrongShow=true + wrongShowManualClear=true → NOT invalid', () => {
  const review = {
    fullText: REAL_REVIEW_BODY,
    textStatus: 'complete',
    wrongShow: true,
    wrongShowManualClear: true,
  };
  const result = classifyContentTier(review);
  assert.notEqual(result.contentTier, 'invalid',
    `manual clear should override wrongShow, got ${result.contentTier} (${result.tierReason})`);
});

test('classifyContentTier: clean review (no flags) → complete/truncated/excerpt (not invalid)', () => {
  const review = {
    fullText: REAL_REVIEW_BODY,
    textStatus: 'complete',
  };
  const result = classifyContentTier(review);
  assert.notEqual(result.contentTier, 'invalid');
});
