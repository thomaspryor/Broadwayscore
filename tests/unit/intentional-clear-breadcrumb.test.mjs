/**
 * Regression test for the GENERALIZED intentional-clear breadcrumb exception.
 *
 * Bug history: the push-review-texts/action.yml restore step and
 * scripts/lib/restore-protected-fields.js both resurrect a PROTECTED field that
 * is empty locally but had content in the committed/remote copy — treating it as
 * data-loss. That is correct for genuine data-loss but WRONG when the empty
 * value is a deliberate clear. The exception was originally hard-coded to
 * duplicateOf/duplicateReason (via duplicateClearReason). Every other manual-clear
 * family (wrongProduction, wrongShow, wrong-article, originalScore) had the SAME
 * bug: a heal/audit would null the flag + write a durable breadcrumb, the rebase
 * would see the null and restore the stale flag, re-flagging a human-verified
 * review. See memory/feedback_push_review_texts_reverts_intentional_clears.md.
 *
 * The decision is now centralized in review-write-guard.js: isIntentionalClear().
 * Per CLAUDE.md §15 this test require()s the real function — it never re-implements
 * the predicate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const repoRoot = path.resolve(__dirname, '..', '..');
const { isIntentionalClear, CLEAR_BREADCRUMBS, PROTECTED_FIELDS } =
  require(path.join(repoRoot, 'scripts/lib/review-write-guard.js'));

// Mirror of the restore decision shared by action.yml and restore-protected-fields.js:
// a field is restored only when it is empty locally, had content committed/remote,
// and is NOT a deliberate clear.
const isEmpty = (v) => v === undefined || v === null
  || (typeof v === 'string' && v.length === 0)
  || (Array.isArray(v) && v.length === 0);
function wouldRestore(field, local, committed) {
  if (isEmpty(local[field]) && isIntentionalClear(field, local)) return false;
  return !isEmpty(committed[field]) && isEmpty(local[field]);
}

test('isIntentionalClear: duplicateOf honored only with duplicateClearReason', () => {
  assert.equal(isIntentionalClear('duplicateOf', { duplicateClearReason: 'sibling gone' }), true);
  assert.equal(isIntentionalClear('duplicateReason', { duplicateClearReason: 'sibling gone' }), true);
  assert.equal(isIntentionalClear('duplicateOf', {}), false);
  assert.equal(isIntentionalClear('duplicateOf', { duplicateClearReason: '' }), false);
});

test('isIntentionalClear: wrongProduction honors every canonical clear signal', () => {
  for (const breadcrumb of [
    { wrongProductionManualClear: true },
    { wrongProductionOverride: true },
    { wrongProductionAutoCleared: true },
    { humanReviewedWrongProduction: false },
    { wrongProductionClearedNote: '[2026-04-26 cleared stale]' },
  ]) {
    assert.equal(isIntentionalClear('wrongProduction', breadcrumb), true,
      `expected clear for ${JSON.stringify(breadcrumb)}`);
    assert.equal(isIntentionalClear('wrongProductionNote', breadcrumb), true);
    assert.equal(isIntentionalClear('wrongProductionReason', breadcrumb), true);
  }
  // No breadcrumb, or the flag merely true (not cleared) → NOT an intentional clear.
  assert.equal(isIntentionalClear('wrongProduction', {}), false);
  assert.equal(isIntentionalClear('wrongProduction', { humanReviewedWrongProduction: true }), false);
});

test('isIntentionalClear: wrongShow and wrong-article families', () => {
  assert.equal(isIntentionalClear('wrongShow', { wrongShowManualClear: true }), true);
  assert.equal(isIntentionalClear('wrongShow', { wrongShowOverride: true }), true);
  assert.equal(isIntentionalClear('wrongShow', { wrongShowAutoCleared: true }), true);
  assert.equal(isIntentionalClear('wrongShowReason', { wrongShowManualClear: true }), true);
  assert.equal(isIntentionalClear('wrongShow', {}), false);

  assert.equal(isIntentionalClear('wrongFullText', { wrongArticleManualClear: true }), true);
  assert.equal(isIntentionalClear('wrongAttribution', { humanReviewedWrongArticle: false }), true);
  assert.equal(isIntentionalClear('wrongFullText', {}), false);
});

test('isIntentionalClear: originalScore cleared via originalScoreCleared breadcrumb', () => {
  assert.equal(isIntentionalClear('originalScore', { originalScoreCleared: true }), true);
  assert.equal(isIntentionalClear('originalScoreSource', { originalScoreCleared: true }), true);
  assert.equal(isIntentionalClear('originalScoreNormalized', { originalScoreCleared: true }), true);
  assert.equal(isIntentionalClear('originalScore', {}), false);
});

test('isIntentionalClear: unknown / unregistered fields default to data-loss protection', () => {
  // assignedScore, fullText etc. have NO clear breadcrumb — they must always be
  // protected. A missing predicate returns false (restore wins).
  assert.equal(isIntentionalClear('assignedScore', { wrongProductionManualClear: true }), false);
  assert.equal(isIntentionalClear('fullText', { duplicateClearReason: 'x' }), false);
  assert.equal(isIntentionalClear('notAField', {}), false);
  assert.equal(isIntentionalClear('duplicateOf', null), false);
});

test('restore decision: intentional clear is NOT reverted; data-loss IS', () => {
  // Manual wrongProduction clear: heal deleted the flag + wrote the breadcrumb.
  const cleared = { wrongProductionManualClear: true }; // wrongProduction deleted
  const committed = { wrongProduction: true, wrongProductionReason: 'film review' };
  assert.equal(wouldRestore('wrongProduction', cleared, committed), false,
    'stale wrongProduction must NOT be resurrected over a manual clear');
  assert.equal(wouldRestore('wrongProductionReason', cleared, committed), false);

  // Genuine data-loss: no breadcrumb, a poller blanked a scored field.
  const lossy = { assignedScore: undefined };
  const good = { assignedScore: 87 };
  assert.equal(wouldRestore('assignedScore', lossy, good), true,
    'a real scored value with no clear breadcrumb must be restored');

  // wrongProduction=false (not empty) is never "restored" regardless.
  assert.equal(wouldRestore('wrongProduction', { wrongProduction: false }, committed), false);
});

test('every CLEAR_BREADCRUMBS key is an actual PROTECTED_FIELD', () => {
  // A breadcrumb for a non-protected field would be dead code — the restore loop
  // only iterates PROTECTED fields, so the exception could never fire.
  for (const field of Object.keys(CLEAR_BREADCRUMBS)) {
    assert.ok(PROTECTED_FIELDS.includes(field),
      `CLEAR_BREADCRUMBS has '${field}' but it is not in PROTECTED_FIELDS`);
  }
});
