import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// require() the REAL functions — no reimplementation. If production logic changes,
// these fail. That is the point (CLAUDE.md §15).
const {
  VALIDATOR_EXCLUSION_FLAGS,
  isSkippedByValidator,
  hasAggregatorUrlMismatch,
  classifyReview,
  evaluateLatentPopulation,
} = require(path.join(REPO_ROOT, 'scripts/lib/aggregator-url-latent.js'));

// ---------------------------------------------------------------------------
// hasAggregatorUrlMismatch
// ---------------------------------------------------------------------------

test('the 2026-08-04 shape: stagedoor listing URL under a real outletId is a mismatch', () => {
  assert.equal(hasAggregatorUrlMismatch({
    outletId: 'artsdesk',
    url: 'https://stagedoor.com/plays/3615-witness-for-the-prosecution/critic-reviews',
  }), true);
});

test('the fix: the outlet\'s own article URL is not a mismatch', () => {
  assert.equal(hasAggregatorUrlMismatch({
    outletId: 'artsdesk',
    url: 'https://theartsdesk.com/theatre/witness-prosecution-london-county-hall-review-return-agatha-christies-gripping-courtroom-drama',
  }), false);
});

test('an aggregator URL under that aggregator\'s OWN outletId is legitimate, not a mismatch', () => {
  // Show Score / Stagedoor records filed under the aggregator itself are how curated
  // excerpts are legitimately stored. Flagging them would be a false positive.
  assert.equal(hasAggregatorUrlMismatch({
    outletId: 'stagedoor',
    url: 'https://stagedoor.com/plays/3615-witness-for-the-prosecution/critic-reviews',
  }), false);
});

test('www. prefix does not defeat the host match', () => {
  assert.equal(hasAggregatorUrlMismatch({
    outletId: 'guardian',
    url: 'https://www.stagedoor.com/plays/123/critic-reviews',
  }), true);
});

test('malformed and missing URLs fail closed without throwing', () => {
  assert.equal(hasAggregatorUrlMismatch({ outletId: 'guardian', url: 'not a url' }), false);
  assert.equal(hasAggregatorUrlMismatch({ outletId: 'guardian' }), false);
  assert.equal(hasAggregatorUrlMismatch(null), false);
  assert.equal(hasAggregatorUrlMismatch(undefined), false);
  assert.equal(hasAggregatorUrlMismatch('nonsense'), false);
});

// ---------------------------------------------------------------------------
// isSkippedByValidator — canonical predicate
// ---------------------------------------------------------------------------

test('every documented exclusion flag, on its own, excludes the review', () => {
  for (const flag of VALIDATOR_EXCLUSION_FLAGS) {
    assert.equal(isSkippedByValidator({ [flag]: true }), true, `${flag} should exclude`);
  }
});

test('falsy flag values do NOT exclude — a cleared flag means the file is live again', () => {
  // This is the auto-clear path that caused the incident: wrongProduction goes
  // truthy -> falsy and the file rejoins the validated population.
  assert.equal(isSkippedByValidator({ wrongProduction: false }), false);
  assert.equal(isSkippedByValidator({ wrongProduction: null }), false);
  assert.equal(isSkippedByValidator({ rejectionReason: '' }), false);
  assert.equal(isSkippedByValidator({}), false);
});

test('validate-review-texts.js consumes the canonical predicate rather than its own copy', () => {
  // A drifted second copy would silently under-report the latent population, which is
  // strictly worse than no guard (memory/feedback_includability_predicates_must_be_canonical.md).
  const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts/validate-review-texts.js'), 'utf-8');
  assert.match(src, /require\(['"]\.\/lib\/aggregator-url-latent['"]\)/,
    'validate-review-texts.js must require the shared predicate');
  assert.match(src, /isSkippedByValidator\(data\)/,
    'validate-review-texts.js must call isSkippedByValidator, not an inline flag chain');
  assert.doesNotMatch(src, /data\.duplicateOf\s*\|\|\s*data\.duplicateTextOf/,
    'the inline exclusion chain must be gone, not merely supplemented');
});

// ---------------------------------------------------------------------------
// classifyReview
// ---------------------------------------------------------------------------

test('classifyReview separates live from latent by exclusion state alone', () => {
  const defect = { outletId: 'artsdesk', url: 'https://stagedoor.com/plays/1/critic-reviews' };
  assert.equal(classifyReview(defect), 'live');
  assert.equal(classifyReview({ ...defect, wrongProduction: true }), 'latent');
  assert.equal(classifyReview({ ...defect, duplicateOf: 'other.json' }), 'latent');
});

test('an excluded file with NO url defect is clean, not latent', () => {
  assert.equal(classifyReview({
    outletId: 'artsdesk',
    url: 'https://theartsdesk.com/theatre/whatever',
    wrongProduction: true,
  }), 'clean');
});

test('the incident transition: clearing wrongProduction flips latent -> live', () => {
  const file = {
    outletId: 'artsdesk',
    url: 'https://stagedoor.com/plays/3615-witness-for-the-prosecution/critic-reviews',
    wrongProduction: true,
  };
  assert.equal(classifyReview(file), 'latent');
  const afterAutoClear = { ...file, wrongProduction: false, wrongProductionAutoCleared: 'rebuild: ...' };
  assert.equal(classifyReview(afterAutoClear), 'live',
    'this is the 2026-08-04 main-red transition — it must be observable');
});

// ---------------------------------------------------------------------------
// evaluateLatentPopulation — the ratchet
// ---------------------------------------------------------------------------

test('growth fails', () => {
  const v = evaluateLatentPopulation(11, 10);
  assert.equal(v.ok, false);
  assert.match(v.reason, /grew/);
});

test('steady passes without a ratchet hint', () => {
  const v = evaluateLatentPopulation(10, 10);
  assert.equal(v.ok, true);
  assert.equal(v.ratchetTo, null);
});

test('shrinkage passes and reports the tighter value — it must never redden the trunk', () => {
  // review-texts is bot-mutated every ~2min; failing when the number IMPROVES would
  // redden main for unrelated pushes.
  const v = evaluateLatentPopulation(4, 10);
  assert.equal(v.ok, true);
  assert.equal(v.ratchetTo, 4);
});

test('zero is a passing, ratchetable state', () => {
  const v = evaluateLatentPopulation(0, 10);
  assert.equal(v.ok, true);
  assert.equal(v.ratchetTo, 0);
});

test('a malformed pin fails closed rather than waving everything through', () => {
  assert.equal(evaluateLatentPopulation(5, undefined).ok, false);
  assert.equal(evaluateLatentPopulation(5, 'ten').ok, false);
  assert.equal(evaluateLatentPopulation(5, -1).ok, false);
  assert.equal(evaluateLatentPopulation(-1, 10).ok, false);
  assert.equal(evaluateLatentPopulation(1.5, 10).ok, false);
});

// ---------------------------------------------------------------------------
// the pin file itself
// ---------------------------------------------------------------------------

test('the pinned ceiling file is present and well-formed', () => {
  const pin = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'scripts/.aggregator-url-latent.json'), 'utf-8'));
  assert.equal(Number.isInteger(pin.latentCeiling), true, 'latentCeiling must be an integer');
  assert.ok(pin.latentCeiling >= 0, 'latentCeiling must be non-negative');
});
