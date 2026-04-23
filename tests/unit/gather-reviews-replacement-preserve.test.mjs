/**
 * gather-reviews URL-replacement must preserve every PROTECTED_FIELD that
 * isn't intentionally cleared.
 *
 * Root cause of the drift (discovered via /ship-check on 2026-04-22):
 * scripts/gather-reviews.js had its own hardcoded 13-field preserve list
 * while review-write-guard.js's canonical PROTECTED_FIELDS kept growing.
 * Every URL re-discovery on a wrongShow/wrongProduction file silently
 * dropped adjudicatedScore, manualContentTier, llmMetadata,
 * contentVerification, ensembleData, humanReviewedWrongProduction,
 * urlManualOverride, pullQuote, designation, isCriticsPick, and more.
 *
 * Fix: scripts/lib/wrongprod-replacement-preserve.js derives preserve list
 * from PROTECTED_FIELDS minus REPLACE_CLEAR_FIELDS, plus aggregator signals
 * and human-decision fields. This test is the guard — if anyone re-inlines
 * the preserve logic or drops fields, it fails loud.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const ROOT = join(import.meta.dirname, '..', '..');
const {
  computeReplacementPreserve,
  AGGREGATOR_FIELDS,
  HUMAN_DECISION_FIELDS,
  REPLACE_CLEAR_FIELDS,
  SCORED_PRESERVE_FIELDS,
} = require(join(ROOT, 'scripts/lib/wrongprod-replacement-preserve.js'));
const { PROTECTED_FIELDS } = require(join(ROOT, 'scripts/lib/review-write-guard.js'));

// Fixture: an existing file where EVERY field has a non-undefined value.
// Using distinct sentinel values so we can prove each one survives (or doesn't).
function buildFullyPopulatedExisting() {
  const obj = {};
  const allFields = new Set([
    ...PROTECTED_FIELDS,
    ...AGGREGATOR_FIELDS,
    ...HUMAN_DECISION_FIELDS,
    'scoreStatus', 'originalRating', 'publishDate', 'criticName',
  ]);
  for (const f of allFields) {
    obj[f] = `SENTINEL_${f}`;
  }
  // Realistic shapes for a few fields that tests will want to inspect
  obj.llmScore = { score: 85, confidence: 'high' };
  obj.humanReviewScore = 72;
  obj.assignedScore = 85;
  obj.fullText = 'a'.repeat(500);
  obj.contentVerification = { wrongArticle: false, isValid: true };
  return obj;
}

test('alreadyScored=true preserves every PROTECTED_FIELD except the intentional-clear set', () => {
  const existing = buildFullyPopulatedExisting();
  const preserved = computeReplacementPreserve(existing, { alreadyScored: true });

  const missing = [];
  const leaked = [];
  for (const f of PROTECTED_FIELDS) {
    if (REPLACE_CLEAR_FIELDS.has(f)) {
      if (preserved[f] !== undefined) leaked.push(f);
    } else {
      if (preserved[f] === undefined) missing.push(f);
    }
  }
  assert.deepStrictEqual(missing, [],
    `PROTECTED_FIELDS dropped on replacement: ${missing.join(', ')}. ` +
      `Root cause drift — this is the exact bug the fix prevents.`);
  assert.deepStrictEqual(leaked, [],
    `Intentional-clear fields leaked through preserve: ${leaked.join(', ')}. ` +
      `Caller's delete block is the safety net, but the preserve list should not include these.`);
});

test('Human-decision fields always preserve, even when alreadyScored=false', () => {
  const existing = buildFullyPopulatedExisting();
  const preserved = computeReplacementPreserve(existing, { alreadyScored: false });

  const missing = HUMAN_DECISION_FIELDS.filter(f => preserved[f] === undefined);
  assert.deepStrictEqual(missing, [],
    `Human-decision fields dropped when not scored: ${missing.join(', ')}. ` +
      `A manual override must survive regardless of scoring state.`);
});

test('Aggregator signals preserve even when alreadyScored=false', () => {
  const existing = buildFullyPopulatedExisting();
  const preserved = computeReplacementPreserve(existing, { alreadyScored: false });
  for (const f of AGGREGATOR_FIELDS) {
    assert.strictEqual(preserved[f], `SENTINEL_${f}`,
      `Aggregator signal ${f} must always preserve (independent of scoring)`);
  }
});

test('alreadyScored=false does NOT preserve scored-only fields (fullText/llmScore/assignedScore)', () => {
  const existing = buildFullyPopulatedExisting();
  const preserved = computeReplacementPreserve(existing, { alreadyScored: false });

  // These are the fields that should only come through when alreadyScored=true.
  // If they leak into an unscored replacement, we'd carry stale fullText from the
  // wrong URL into the new URL's slot — exactly the pollution the gate prevents.
  for (const f of ['fullText', 'llmScore', 'assignedScore', 'contentTierReason', 'ensembleData']) {
    // Some of these are in HUMAN_DECISION_FIELDS or AGGREGATOR_FIELDS; filter to the
    // ones that should truly be absent.
    if (HUMAN_DECISION_FIELDS.includes(f) || AGGREGATOR_FIELDS.includes(f)) continue;
    assert.strictEqual(preserved[f], undefined,
      `${f} leaked through when alreadyScored=false — pollutes new URL with stale content`);
  }
});

test('Returns empty object on null/undefined existing file (no crash)', () => {
  assert.deepStrictEqual(computeReplacementPreserve(null, { alreadyScored: true }), {});
  assert.deepStrictEqual(computeReplacementPreserve(undefined, { alreadyScored: false }), {});
  assert.deepStrictEqual(computeReplacementPreserve({}, { alreadyScored: true }), {});
});

test('Skips undefined fields in existing — only preserves what is actually set', () => {
  const existing = {
    fullText: 'real content',
    assignedScore: 85,
    // llmScore, humanReviewScore, etc. intentionally undefined
  };
  const preserved = computeReplacementPreserve(existing, { alreadyScored: true });
  assert.strictEqual(preserved.fullText, 'real content');
  assert.strictEqual(preserved.assignedScore, 85);
  // Undefined fields shouldn't appear in preserved at all
  assert.strictEqual(Object.prototype.hasOwnProperty.call(preserved, 'llmScore'), false);
});

// --- Wiring test: gather-reviews.js must actually call the helper ---

test('scripts/gather-reviews.js requires and calls computeReplacementPreserve', () => {
  const src = readFileSync(join(ROOT, 'scripts/gather-reviews.js'), 'utf8');
  assert.ok(
    /require\(['"]\.\/lib\/wrongprod-replacement-preserve['"]\)/.test(src),
    'gather-reviews.js no longer requires ./lib/wrongprod-replacement-preserve — ' +
      'someone re-inlined the preserve logic. Drift will recur.'
  );
  assert.ok(
    /computeReplacementPreserve\(existingReview/.test(src),
    'gather-reviews.js imports computeReplacementPreserve but never calls it on existingReview.'
  );
});

// --- Regression test: the canonical drift bug would have been caught here ---

test('REGRESSION: hardcoded legacy-13 list would fail this test', () => {
  // Simulate the pre-fix behavior: preserve only the legacy 13 fields.
  const LEGACY_13 = ['fullText', 'llmScore', 'humanReviewScore', 'scoreStatus',
    'isFullReview', 'contentTier', 'contentTierReason', 'originalScore',
    'originalScoreNormalized', 'originalScoreSource', 'originalRating',
    'publishDate', 'criticName'];
  const existing = buildFullyPopulatedExisting();
  const legacyPreserved = {};
  for (const k of LEGACY_13) {
    if (existing[k] !== undefined) legacyPreserved[k] = existing[k];
  }
  // Pick one field the legacy list drops that the current fix preserves:
  assert.strictEqual(legacyPreserved.adjudicatedScore, undefined,
    'If legacyPreserved has adjudicatedScore, the legacy list has been fixed inline — update this test.');
  assert.strictEqual(legacyPreserved.humanReviewedWrongProduction, undefined);
  assert.strictEqual(legacyPreserved.manualContentTier, undefined);
  // Confirm the new function does NOT drop them:
  const current = computeReplacementPreserve(existing, { alreadyScored: true });
  assert.ok(current.adjudicatedScore !== undefined,
    'adjudicatedScore is the canary — if dropped here, the drift is back');
  assert.ok(current.humanReviewedWrongProduction !== undefined);
  assert.ok(current.manualContentTier !== undefined);
});
