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

test('provisional=true makes humanReviewScoreProvisional=true (LLM can override)', () => {
  const fields = buildManualReviewFields({
    humanScore: 70,
    provisional: true,
    fullText: 'Tentative take before full text arrives. '.repeat(10),
  });
  assert.equal(fields.humanReviewScore, 70);
  assert.equal(fields.humanReviewScoreProvisional, true);
  // The other protection fields still apply — it's only the score LOCK that
  // relaxes; wrongProduction / allowEarlyDate etc. still bypass their guards.
  assertCore8(fields, { expectManualContentTier: true });
});

test('provisional omitted defaults to false (backwards-compatible with pre-P2 callers)', () => {
  const fields = buildManualReviewFields({ humanScore: 82 });
  assert.equal(fields.humanReviewScoreProvisional, false);
});

test('provisional=true with no humanScore is a no-op on the provisional field', () => {
  const fields = buildManualReviewFields({ provisional: true, fullText: 'x'.repeat(500) });
  assert.equal(fields.humanReviewScore, undefined, 'no score → no humanReviewScore');
  assert.equal(fields.humanReviewScoreProvisional, undefined, 'no score → no provisional flag to set');
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

// --- operatorTrust gate (2026-06-21, Notion 386637c5) ---------------------
// Automated callers (audit-aggregator-gap → ingest-review-from-url,
// poll-loureviews) must NOT stamp the operator override set. Doing so made
// machine-ingested aggregator URLs immune to wrong-production / cross-market /
// date guards and re-admitted 335 contaminated reviews across 160 shows.

// Every override field that exempts a review from a downstream guard.
const OVERRIDE_FIELDS = [
  'wrongProduction', 'wrongProductionManualClear', 'wrongProductionOverride',
  'wrongShow', 'wrongShowManualClear', 'wrongArticleManualClear',
  'humanReviewedWrongProduction', 'humanReviewedWrongArticle',
  'allowEarlyDate', 'allowLateDate', 'allowCrossMarket',
  'allowTourSignal', 'allowFilmSignal', 'contentVerification',
];

test('operatorTrust defaults to true (genuine manual path keeps full override set)', () => {
  const fields = buildManualReviewFields({ fullText: 'x'.repeat(500) });
  assertCore8(fields, { expectManualContentTier: true });
  assert.equal(fields.fetchMethod, 'manual-entry');
  assert.ok(Array.isArray(fields.protectedFields));
});

test('operatorTrust:false omits EVERY override field — review stays subject to guards', () => {
  const fields = buildManualReviewFields({
    fullText: 'An automated aggregator-gap ingest of a review URL. '.repeat(20),
    publishDate: '2023-12-14',
    operatorTrust: false,
  });
  for (const f of OVERRIDE_FIELDS) {
    assert.equal(fields[f], undefined, `operatorTrust:false must NOT set ${f}`);
  }
  // No per-file protection lock either — nothing to protect; it's a normal review.
  assert.equal(fields.protectedFields, undefined, 'operatorTrust:false must not write a protectedFields lock');
  // And it must not lie about being a manual entry / content-complete.
  assert.equal(fields.fetchMethod, 'url-ingest', 'automated ingest records url-ingest, not manual-entry');
  assert.equal(fields.manualContentTier, undefined, 'automated ingest must not lock content tier');
});

test('operatorTrust:false still records the real review payload', () => {
  const fields = buildManualReviewFields({
    fullText: 'y'.repeat(500),
    publishDate: '2024-05-01',
    operatorTrust: false,
  });
  assert.ok(fields.fullText, 'fullText preserved');
  assert.ok(fields.textFetchedAt, 'textFetchedAt preserved');
  assert.equal(fields.publishDate, '2024-05-01', 'publishDate preserved');
});
