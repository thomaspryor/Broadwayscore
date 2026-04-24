/**
 * Regression test for Beaches 2026-04-22 opening-night postmortem #6.
 *
 * The manual ingest script silently dropped 4 reviews because it set only 3 of
 * the 8 fields that bypass downstream guards. This test pins the invariant:
 * buildManualReviewFields() must always emit the 8 protection fields so a
 * future edit can't regress.
 *
 * Run: node --test tests/unit/ingest-manual-review-fields.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildManualReviewFields } = require('../../scripts/lib/manual-review-fields.js');

// The 8 fields from the consolidated plan Session 2 #6. Each one bypasses a
// different downstream guard — dropping any one re-flags a human-verified review
// on the next rebuild.
function assertCore8(fields, { expectManualContentTier }) {
  assert.equal(fields.wrongProduction, false, 'wrongProduction must be false');
  assert.equal(fields.wrongProductionManualClear, true, 'wrongProductionManualClear must be true');
  assert.equal(fields.allowEarlyDate, true, 'allowEarlyDate must be true');
  assert.equal(fields.wrongShow, false, 'wrongShow must be false');
  assert.ok(fields.contentVerification, 'contentVerification must be present');
  assert.equal(fields.contentVerification.wrongProduction, false, 'contentVerification.wrongProduction must be false');
  assert.equal(fields.contentVerification.wrongArticle, false, 'contentVerification.wrongArticle must be false');
  assert.equal(fields.humanReviewedWrongProduction, false, 'humanReviewedWrongProduction must be false');
  if (expectManualContentTier) {
    assert.equal(fields.manualContentTier, 'complete', 'manualContentTier must be "complete" when fullText is present');
  }
}

test('8 protection fields are set with full text + score', () => {
  const fields = buildManualReviewFields({
    humanScore: 82,
    fullText: 'A strong revival that earns its place. '.repeat(20),
  });
  assertCore8(fields, { expectManualContentTier: true });
  assert.equal(fields.humanReviewScore, 82);
  assert.equal(fields.humanReviewScoreProvisional, false, 'locked-in humanReviewScore must set provisional=false');
});

test('8 protection fields are set with score only (no text)', () => {
  const fields = buildManualReviewFields({ humanScore: 63 });
  // manualContentTier only applies when we actually have text
  assertCore8(fields, { expectManualContentTier: false });
  assert.equal(fields.manualContentTier, undefined, 'no text → no manualContentTier claim');
  assert.equal(fields.humanReviewScore, 63);
});

test('8 protection fields are set with text only (LLM-scored case)', () => {
  const fields = buildManualReviewFields({ fullText: 'x'.repeat(500) });
  assertCore8(fields, { expectManualContentTier: true });
  assert.equal(fields.humanReviewScore, undefined);
});

test('protectedFields array includes every field this ingest writes', () => {
  const fields = buildManualReviewFields({ humanScore: 82, fullText: 'x'.repeat(500) });
  assert.ok(Array.isArray(fields.protectedFields));
  for (const f of [
    'humanReviewScore', 'humanReviewScoreProvisional', 'manualContentTier',
    'wrongProduction', 'wrongProductionManualClear', 'wrongProductionOverride',
    'wrongShow', 'wrongShowManualClear', 'wrongArticleManualClear',
    'humanReviewedWrongProduction', 'humanReviewedWrongArticle',
    'allowEarlyDate', 'allowLateDate', 'allowCrossMarket',
    'allowTourSignal', 'allowFilmSignal', 'contentVerification',
    'fullText', 'textFetchedAt',
  ]) {
    assert.ok(fields.protectedFields.includes(f),
      `per-file protectedFields must lock ${f}`);
  }
});

test('originalScore passes through when star rating supplied', () => {
  const fields = buildManualReviewFields({
    humanScore: 80,
    originalScore: '4/5',
    originalScoreSource: 'manual-stars',
  });
  assert.equal(fields.originalScore, '4/5');
  assert.equal(fields.originalScoreSource, 'manual-stars');
  assert.equal(fields.originalScoreNormalized, 80);
});

test('publishDate is passed through when supplied', () => {
  const fields = buildManualReviewFields({ humanScore: 80, publishDate: '2026-04-22' });
  assert.equal(fields.publishDate, '2026-04-22');
});
