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
  DEFAULT_GRACE_BAND,
  VALIDATOR_EXCLUSION_FLAGS,
  resolveOutletId,
  isSkippedByValidator,
  hasAggregatorUrlMismatch,
  classifyReview,
  evaluateLatentPopulation,
  evaluateScanIntegrity,
} = require(path.join(REPO_ROOT, 'scripts/lib/aggregator-url-latent.js'));

// The validator's own resolution, imported separately so a change to EITHER side
// breaks this test rather than silently diverging.
const { normalizeOutlet } = require(path.join(REPO_ROOT, 'scripts/lib/review-normalization.js'));

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

test('isNotReview excludes — the durable form of a stripped rejectionReason', () => {
  // 2026-08-17: the LBO roundup scrape stripped rejectionReason (deliberately NOT
  // in PROTECTED_FIELDS, see review-write-guard.js) from a 0-word LBO boilerplate
  // disclaimer that three LLMs had unanimously rejected. It re-entered the
  // validated population carrying an aggregator URL under outletId "telegraph" and
  // failed a zero-tolerance trunk gate. isNotReview IS protected, so it survives a
  // re-scrape; before this it was honoured by review-guards.js but not here.
  const resurrected = {
    outletId: 'telegraph',
    url: 'https://www.londonboxoffice.co.uk/news/post/review-round-up-christmas-carol-goes-wrong-apollo-theatre',
    isNotReview: true,
    isNotReviewReason: 'LBO boilerplate disclaimer, not a review',
  };
  assert.equal(isSkippedByValidator(resurrected), true,
    'a record explicitly marked "not a review" must not be validated as a review');
  // ...and it must still be a mismatch on its own facts, so removing the flag
  // brings the error straight back rather than the flag masking a fixed bug.
  const { isNotReview, isNotReviewReason, ...unflagged } = resurrected;
  assert.equal(isSkippedByValidator(unflagged), false);
  assert.equal(hasAggregatorUrlMismatch(unflagged), true);
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

test('drift of one file does NOT fail — that would be the churn pathology, not a fix', () => {
  // CI checks out review-texts' moving main HEAD; a bot landing one bad file mid-run
  // must not fail an unrelated merge. This is the single most important behavior here.
  const v = evaluateLatentPopulation(11, 10);
  assert.equal(v.ok, true, 'one extra file must not redden the trunk');
  assert.equal(v.warn, true, 'but it must be loudly annotated');
});

test('drift at the edge of the band still passes', () => {
  const v = evaluateLatentPopulation(10 + DEFAULT_GRACE_BAND, 10);
  assert.equal(v.ok, true);
  assert.equal(v.warn, true);
});

test('a spike one past the band fails', () => {
  const v = evaluateLatentPopulation(10 + DEFAULT_GRACE_BAND + 1, 10);
  assert.equal(v.ok, false);
  assert.match(v.reason, /SPIKED/);
});

test('a producer-regression-sized spike fails hard', () => {
  // The historical shape: 27 and 32 files appearing at once.
  const v = evaluateLatentPopulation(32, 10);
  assert.equal(v.ok, false);
});

test('a negative or non-integer grace band fails closed', () => {
  assert.equal(evaluateLatentPopulation(10, 10, -1).ok, false);
  assert.equal(evaluateLatentPopulation(10, 10, 1.5).ok, false);
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
  assert.equal(Number.isInteger(pin.graceBand), true, 'graceBand must be an integer');
  assert.equal(Number.isInteger(pin.minScanned), true, 'minScanned must be an integer');
  assert.ok(pin.minScanned > 1000, 'minScanned must be a real floor, not a rubber stamp');
});

// ---------------------------------------------------------------------------
// outletId resolution parity with the validator
// ---------------------------------------------------------------------------

test('resolveOutletId matches the validator\'s normalizeOutletId exactly', () => {
  // validate-review-texts.js:136 is `if (!id) return null; return normalizeOutlet(id);`
  for (const id of ['artsdesk', 'The Arts Desk', 'ARTSDESK', 'times-uk', '', null, undefined]) {
    const expected = id ? normalizeOutlet(id) : null;
    assert.deepEqual(resolveOutletId(id), expected, `divergence on ${JSON.stringify(id)}`);
  }
});

test('an `outlet`-only record IS counted, because that is what the validator does', () => {
  // The validator reads normalizeOutletId(data.outletId) ONLY — it never falls back to
  // data.outlet. With no outletId that resolves to null, null is not in
  // AGGREGATOR_OUTLET_IDS, so the aggregator URL trips the mismatch. Matching that
  // exactly is the point; an `outlet` fallback here would have made the ratchet count
  // a DIFFERENT population than the gate it protects (Codex finding, #1002).
  assert.equal(hasAggregatorUrlMismatch({
    outlet: 'The Arts Desk',
    url: 'https://stagedoor.com/plays/1/critic-reviews',
  }), true);
  // And an outlet-only record naming the aggregator itself is still counted, for the
  // same reason — the validator cannot see `outlet` either. This is deliberate parity,
  // not a judgement that the behavior is ideal.
  assert.equal(hasAggregatorUrlMismatch({
    outlet: 'Stagedoor',
    url: 'https://stagedoor.com/plays/1/critic-reviews',
  }), true);
});

// ---------------------------------------------------------------------------
// scan integrity — a blind scan must never read as "improved"
// ---------------------------------------------------------------------------

test('a scan that saw almost nothing cannot report a pass', () => {
  const v = evaluateScanIntegrity(12, 0, { minScanned: 30000 });
  assert.equal(v.ok, false);
  assert.match(v.reason, /below the floor/);
});

test('a scan with too many unreadable entries cannot report a pass', () => {
  const v = evaluateScanIntegrity(40000, 500, { minScanned: 30000, maxScanErrors: 50 });
  assert.equal(v.ok, false);
  assert.match(v.reason, /unreadable/);
});

test('a healthy full scan passes integrity', () => {
  const v = evaluateScanIntegrity(41884, 0, { minScanned: 30000, maxScanErrors: 50 });
  assert.equal(v.ok, true);
});

test('the wiped-corpus trap: 0 files scanned must never look like a clean corpus', () => {
  // Without this, an empty/failed checkout yields latent=0, which evaluateLatentPopulation
  // would happily call "shrank to 0 — tighten the pin".
  assert.equal(evaluateLatentPopulation(0, 10).ok, true, 'population check alone is fooled');
  assert.equal(evaluateScanIntegrity(0, 0, { minScanned: 30000 }).ok, false, 'integrity check catches it');
});
