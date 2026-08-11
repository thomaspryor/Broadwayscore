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

test('isIntentionalClear: wrongProduction matches the canonical human-clear triplet', () => {
  for (const breadcrumb of [
    { wrongProductionManualClear: true },
    { wrongProductionOverride: true },
    { humanReviewedWrongProduction: false },
  ]) {
    assert.equal(isIntentionalClear('wrongProduction', breadcrumb), true,
      `expected clear for ${JSON.stringify(breadcrumb)}`);
    assert.equal(isIntentionalClear('wrongProductionNote', breadcrumb), true);
    assert.equal(isIntentionalClear('wrongProductionReason', breadcrumb), true);
  }
  // No breadcrumb, or the flag merely true (not cleared) → NOT an intentional clear.
  assert.equal(isIntentionalClear('wrongProduction', {}), false);
  assert.equal(isIntentionalClear('wrongProduction', { humanReviewedWrongProduction: true }), false);
  // Rebuild's string-typed auto-clear is NOT a manual clear (and sets the flag to
  // `false`, not empty) — must match review-guards.js, which ignores it.
  assert.equal(isIntentionalClear('wrongProduction', { wrongProductionAutoCleared: 'rebuild: UK URL' }), false);
  // ClearedNote alone (without ManualClear) is not a clear signal on its own.
  assert.equal(isIntentionalClear('wrongProduction', { wrongProductionClearedNote: 'x' }), false);
});

test('isIntentionalClear: wrongShow reuses canonical wrongShowCleared (incl. production signals)', () => {
  assert.equal(isIntentionalClear('wrongShow', { wrongShowManualClear: true }), true);
  assert.equal(isIntentionalClear('wrongShow', { wrongShowOverride: true }), true);
  assert.equal(isIntentionalClear('wrongShowReason', { wrongShowManualClear: true }), true);
  // Canonical wrongShowCleared also honors production-level human clears.
  assert.equal(isIntentionalClear('wrongShow', { wrongProductionManualClear: true }), true);
  assert.equal(isIntentionalClear('wrongShow', { humanReviewedWrongProduction: false }), true);
  // String-typed auto-clear not honored; no breadcrumb not honored.
  assert.equal(isIntentionalClear('wrongShow', { wrongShowAutoCleared: 'rebuild: x' }), false);
  assert.equal(isIntentionalClear('wrongShow', {}), false);
});

test('isIntentionalClear: wrong-article family', () => {
  assert.equal(isIntentionalClear('wrongFullText', { wrongArticleManualClear: true }), true);
  assert.equal(isIntentionalClear('wrongAttribution', { humanReviewedWrongArticle: false }), true);
  assert.equal(isIntentionalClear('wrongFullText', {}), false);
});

test('isIntentionalClear: rediscover reset (_previousWrongFlags) is honored, sub-field precise', () => {
  // rediscover-review-urls.js deletes the flag + records the prior value.
  const reWP = { _previousWrongFlags: { wrongProduction: true, wrongShow: false } };
  assert.equal(isIntentionalClear('wrongProduction', reWP), true);
  assert.equal(isIntentionalClear('wrongProductionReason', reWP), true);
  // It only cleared wrongProduction → do NOT suppress a wrongShow restore.
  assert.equal(isIntentionalClear('wrongShow', reWP), false);

  const reWS = { _previousWrongFlags: { wrongProduction: false, wrongShow: true } };
  assert.equal(isIntentionalClear('wrongShow', reWS), true);
  assert.equal(isIntentionalClear('wrongProduction', reWS), false);

  // Both cleared.
  const reBoth = { _previousWrongFlags: { wrongProduction: true, wrongShow: true } };
  assert.equal(isIntentionalClear('wrongProduction', reBoth), true);
  assert.equal(isIntentionalClear('wrongShow', reBoth), true);

  // Absent / empty marker → not a clear.
  assert.equal(isIntentionalClear('wrongProduction', { _previousWrongFlags: {} }), false);
  assert.equal(isIntentionalClear('wrongShow', {}), false);
});

test('_previousWrongFlags is itself a PROTECTED_FIELD (breadcrumb must survive rebase)', () => {
  assert.ok(PROTECTED_FIELDS.includes('_previousWrongFlags'),
    '_previousWrongFlags must be protected so the rediscover clear signal is not lost on rebase');
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

// ── FRESH rebuild auto-clear breadcrumb (2026-08-04, cross-market FP ping-pong) ──
// The rebuild's self-heal deletes wrongProduction and stamps
// wrongProductionAutoCleared(+At); the push-time restore resurrected the flag in
// the SAME run ("Protected: …liamodell--liam-odell.json"), so no auto-clear
// could ever stick. Fresh (≤7d) stamped clears must suppress the restore;
// stale or At-less stamps must NOT (data-loss protection wins).
const today = new Date().toISOString().split('T')[0];
const committedFlagged = {
  wrongProduction: true,
  wrongProductionNote: 'Cross-market: US outlet "liamodell" reviewing London show',
};

test('fresh auto-clear (stamped today) suppresses wrongProduction restore', () => {
  const local = {
    wrongProductionAutoCleared: "rebuild: registry region 'london' outlet on London show (liamodell)",
    wrongProductionAutoClearedAt: today,
  };
  assert.equal(wouldRestore('wrongProduction', local, committedFlagged), false);
  assert.equal(wouldRestore('wrongProductionNote', local, committedFlagged), false);
});

test('boolean-true merge-path stamp with fresh At also suppresses restore', () => {
  const local = { wrongProductionAutoCleared: true, wrongProductionAutoClearedAt: today };
  assert.equal(wouldRestore('wrongProduction', local, committedFlagged), false);
});

test('STALE auto-clear stamp (30d old) does NOT suppress restore', () => {
  const local = {
    wrongProductionAutoCleared: 'rebuild: UK URL on London show (example.co.uk)',
    wrongProductionAutoClearedAt: new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0],
  };
  assert.equal(wouldRestore('wrongProduction', local, committedFlagged), true);
});

test('auto-clear stamp WITHOUT an At date does NOT suppress restore', () => {
  const local = { wrongProductionAutoCleared: 'rebuild: UK URL on London show (x.co.uk)' };
  assert.equal(wouldRestore('wrongProduction', local, committedFlagged), true);
});

test('fresh auto-clear does NOT extend to wrongProductionReason (manual-reason clears stay human-only)', () => {
  const local = {
    wrongProductionAutoCleared: 'rebuild: whatever',
    wrongProductionAutoClearedAt: today,
  };
  const committed = { wrongProductionReason: 'manually flagged: tour listing page' };
  assert.equal(wouldRestore('wrongProductionReason', local, committed), true);
});

// ── Task #97 audit: staleScoredBeforeOpening (strip-stale-single-model-scores.js
// --before-opening mode, run inline by opening-night-express.yml before the SAME
// job's push-review-texts step). FRESHNESS-GATED (codex adversarial review,
// 2026-08-10): a bare boolean with no expiry would suppress restoring ANY future,
// unrelated score loss on the file forever — see _freshStaleScoredBeforeOpening. ──

const scoreStripToday = new Date().toISOString();

test('isIntentionalClear: fresh staleScoredBeforeOpening covers the score family it strips', () => {
  const cleared = { staleScoredBeforeOpening: true, staleScoredBeforeOpeningAt: scoreStripToday };
  for (const field of ['assignedScore', 'llmScore', 'llmMetadata', 'ensembleData']) {
    assert.equal(isIntentionalClear(field, cleared), true, `expected clear for ${field}`);
  }
  // No stamp, a falsy stamp, or a stamp with no timestamp must NOT suppress the restore.
  assert.equal(isIntentionalClear('assignedScore', {}), false);
  assert.equal(isIntentionalClear('assignedScore', { staleScoredBeforeOpening: false }), false);
  assert.equal(isIntentionalClear('assignedScore', { staleScoredBeforeOpening: true }), false);
});

test('isIntentionalClear: STALE staleScoredBeforeOpening (>3d old) does NOT suppress restore', () => {
  const stale = {
    staleScoredBeforeOpening: true,
    staleScoredBeforeOpeningAt: new Date(Date.now() - 10 * 86400000).toISOString(),
  };
  assert.equal(isIntentionalClear('assignedScore', stale), false);
});

test('isIntentionalClear: FUTURE-dated staleScoredBeforeOpeningAt does NOT suppress restore (codex review, task #1237)', () => {
  // A negative age (future timestamp — malformed write or clock skew) must not
  // pass the `<= FRESH_DAYS` check and suppress restoring data loss forever.
  const future = {
    staleScoredBeforeOpening: true,
    staleScoredBeforeOpeningAt: new Date(Date.now() + 30 * 86400000).toISOString(),
  };
  assert.equal(isIntentionalClear('assignedScore', future), false);
});

test('staleScoredBeforeOpening(+At) and needsRescore are themselves PROTECTED_FIELDs', () => {
  assert.ok(PROTECTED_FIELDS.includes('staleScoredBeforeOpening'));
  assert.ok(PROTECTED_FIELDS.includes('staleScoredBeforeOpeningAt'));
  assert.ok(PROTECTED_FIELDS.includes('needsRescore'));
});

test('restore decision: opening-night score strip is NOT reverted by the same-job restore', () => {
  // Reproduces the opening-night-express.yml shape: strip-stale-single-model-
  // scores.js --before-opening nulls the score family in the SAME checkout
  // whose HEAD (committed) still carries the pre-strip score — the exact
  // "committed has content, local is empty" pattern the restore treats as
  // data loss without this breadcrumb.
  const local = {
    assignedScore: null, llmScore: null, llmMetadata: null, ensembleData: null,
    staleScoredBeforeOpening: true, staleScoredBeforeOpeningAt: scoreStripToday, needsRescore: true,
  };
  const committed = { assignedScore: 82, llmScore: { score: 82 }, llmMetadata: { model: 'x' }, ensembleData: { members: 3 } };
  for (const field of ['assignedScore', 'llmScore', 'llmMetadata', 'ensembleData']) {
    assert.equal(wouldRestore(field, local, committed), false,
      `stale pre-opening ${field} must NOT be resurrected over an intentional strip`);
  }
});

test('markRescoreComplete clears staleScoredBeforeOpening(+At) once a real score lands', () => {
  const { markRescoreComplete } = require(path.join(repoRoot, 'scripts/lib/rescore-lifecycle.js'));
  const scored = markRescoreComplete({
    needsRescore: true,
    staleScoredBeforeOpening: true,
    staleScoredBeforeOpeningAt: scoreStripToday,
    assignedScore: 91,
  });
  assert.equal(scored.staleScoredBeforeOpening, undefined);
  assert.equal(scored.staleScoredBeforeOpeningAt, undefined);
  // Post-rescore, a later unrelated null of the score IS treated as data loss again.
  assert.equal(isIntentionalClear('assignedScore', { ...scored, assignedScore: null }), false);
});

// ── Task #1237 audit: fullTextWrongAuthor (apply-audit-flags.js, run by the SAME
// rebuild-reviews.yml job that later calls push-review-texts twice). Same shape
// as staleScoredBeforeOpening above: FRESHNESS-GATED so a bare boolean with no
// expiry can't suppress restoring ANY future, unrelated data loss on the file. ──

const wrongAuthorToday = new Date().toISOString();

test('isIntentionalClear: fresh fullTextWrongAuthor covers fullText/assignedScore/ensembleData', () => {
  const cleared = { fullTextWrongAuthor: true, fullTextWrongAuthorAt: wrongAuthorToday };
  for (const field of ['fullText', 'assignedScore', 'ensembleData']) {
    assert.equal(isIntentionalClear(field, cleared), true, `expected clear for ${field}`);
  }
  // No stamp, a falsy stamp, or a stamp with no timestamp must NOT suppress the restore.
  assert.equal(isIntentionalClear('fullText', {}), false);
  assert.equal(isIntentionalClear('fullText', { fullTextWrongAuthor: false }), false);
  assert.equal(isIntentionalClear('fullText', { fullTextWrongAuthor: true }), false);
});

test('isIntentionalClear: STALE fullTextWrongAuthor (>3d old) does NOT suppress restore', () => {
  const stale = {
    fullTextWrongAuthor: true,
    fullTextWrongAuthorAt: new Date(Date.now() - 10 * 86400000).toISOString(),
  };
  for (const field of ['fullText', 'assignedScore', 'ensembleData']) {
    assert.equal(isIntentionalClear(field, stale), false);
  }
});

test('isIntentionalClear: FUTURE-dated fullTextWrongAuthorAt does NOT suppress restore (codex review, task #1237)', () => {
  const future = {
    fullTextWrongAuthor: true,
    fullTextWrongAuthorAt: new Date(Date.now() + 30 * 86400000).toISOString(),
  };
  for (const field of ['fullText', 'assignedScore', 'ensembleData']) {
    assert.equal(isIntentionalClear(field, future), false);
  }
});

test('fullTextWrongAuthor(+At) is itself a PROTECTED_FIELD', () => {
  assert.ok(PROTECTED_FIELDS.includes('fullTextWrongAuthor'));
  assert.ok(PROTECTED_FIELDS.includes('fullTextWrongAuthorAt'));
});

test('restore decision: apply-audit-flags.js wrong-author strip is NOT reverted by the same-job restore', () => {
  // Reproduces the rebuild-reviews.yml shape: apply-audit-flags.js deletes
  // fullText/assignedScore/ensembleData in the SAME checkout whose HEAD
  // (committed) still carries the wrong-author content — the exact
  // "committed has content, local is empty" pattern the restore treats as
  // data loss without this breadcrumb.
  const local = {
    fullTextWrongAuthor: true, fullTextWrongAuthorAt: wrongAuthorToday, needsRescore: 'fullTextWrongAuthor-applied',
  };
  const committed = { fullText: 'wrong-author article text', assignedScore: 82, ensembleData: { members: 3 } };
  for (const field of ['fullText', 'assignedScore', 'ensembleData']) {
    assert.equal(wouldRestore(field, local, committed), false,
      `stale wrong-author ${field} must NOT be resurrected over an intentional strip`);
  }
});

test('fullTextWrongAuthor breadcrumb does NOT extend to llmScore/llmMetadata (apply-audit-flags.js does not clear those)', () => {
  const cleared = { fullTextWrongAuthor: true, fullTextWrongAuthorAt: wrongAuthorToday };
  assert.equal(isIntentionalClear('llmScore', cleared), false);
  assert.equal(isIntentionalClear('llmMetadata', cleared), false);
});

test('collect-review-texts.js / backfill-theaterlife-bylines.js reset paths clear fullTextWrongAuthor(+At) together', () => {
  const collectSrc = require('node:fs').readFileSync(
    path.join(repoRoot, 'scripts/collect-review-texts.js'), 'utf8');
  const backfillSrc = require('node:fs').readFileSync(
    path.join(repoRoot, 'scripts/backfill-theaterlife-bylines.js'), 'utf8');
  // Every site that deletes the flag must delete the freshness stamp alongside
  // it, or a stale stamp survives the "corrected" write and keeps suppressing
  // restores of a LATER, unrelated data loss on the same file.
  const collectClearSites = collectSrc.split('delete data.fullTextWrongAuthor;').length - 1;
  const collectAtClearSites = collectSrc.split('delete data.fullTextWrongAuthorAt;').length - 1;
  assert.equal(collectAtClearSites, collectClearSites,
    'every delete data.fullTextWrongAuthor; site in collect-review-texts.js must also delete fullTextWrongAuthorAt');
  assert.ok(collectClearSites >= 3, 'expected the 3 known reset sites in collect-review-texts.js');
  assert.ok(backfillSrc.includes('delete newData.fullTextWrongAuthor;\n  delete newData.fullTextWrongAuthorAt;')
    || backfillSrc.includes('delete newData.fullTextWrongAuthor;\n\tdelete newData.fullTextWrongAuthorAt;'),
    'backfill-theaterlife-bylines.js must clear fullTextWrongAuthorAt alongside fullTextWrongAuthor');
});

test('re-flagging invalidates the auto-clear stamp (inverted-ping-pong guard, ship-check 2026-08-04)', async () => {
  const { invalidateWrongProductionAutoClear } =
    require(path.join(repoRoot, 'scripts/lib/review-write-guard.js'));
  const d = {
    wrongProductionAutoCleared: 'rebuild: registry region london outlet on London show (x)',
    wrongProductionAutoClearedAt: new Date().toISOString().split('T')[0],
  };
  // fresh stamp suppresses restore…
  assert.equal(wouldRestore('wrongProduction', d, { wrongProduction: true }), false);
  // …until a writer re-flags and invalidates it
  d.wrongProduction = true;
  invalidateWrongProductionAutoClear(d);
  assert.equal(d.wrongProductionAutoCleared, undefined);
  assert.equal(d.wrongProductionAutoClearedAt, undefined);
  // a later stale-checkout copy WITHOUT the flag now restores normally
  const staleLocal = {};
  assert.equal(wouldRestore('wrongProduction', staleLocal, { wrongProduction: true }), true);
});

// ── Task #1259 audit: stuckRescoreCleared (audit-stuck-rescore-flags.js --fix,
// run by the SAME enrich-reviews.yml job that later calls push-review-texts).
// Same shape as staleScoredBeforeOpening/fullTextWrongAuthor above:
// FRESHNESS-GATED so a bare boolean with no expiry can't suppress restoring
// ANY future, unrelated re-flag of needsRescore on the file. ──

const stuckRescoreToday = new Date().toISOString();

test('isIntentionalClear: fresh stuckRescoreCleared covers needsRescore/rescoreReason/lateStarAnchorBand', () => {
  const cleared = { stuckRescoreCleared: true, stuckRescoreClearedAt: stuckRescoreToday };
  for (const field of ['needsRescore', 'rescoreReason', 'lateStarAnchorBand']) {
    assert.equal(isIntentionalClear(field, cleared), true, `expected clear for ${field}`);
  }
  // No stamp, a falsy stamp, or a stamp with no timestamp must NOT suppress the restore.
  assert.equal(isIntentionalClear('needsRescore', {}), false);
  assert.equal(isIntentionalClear('needsRescore', { stuckRescoreCleared: false }), false);
  assert.equal(isIntentionalClear('needsRescore', { stuckRescoreCleared: true }), false);
});

test('isIntentionalClear: STALE stuckRescoreCleared (>3d old) does NOT suppress restore', () => {
  const stale = {
    stuckRescoreCleared: true,
    stuckRescoreClearedAt: new Date(Date.now() - 10 * 86400000).toISOString(),
  };
  for (const field of ['needsRescore', 'rescoreReason', 'lateStarAnchorBand']) {
    assert.equal(isIntentionalClear(field, stale), false);
  }
});

test('isIntentionalClear: FUTURE-dated stuckRescoreClearedAt does NOT suppress restore (mirrors codex review, task #1237)', () => {
  const future = {
    stuckRescoreCleared: true,
    stuckRescoreClearedAt: new Date(Date.now() + 30 * 86400000).toISOString(),
  };
  for (const field of ['needsRescore', 'rescoreReason', 'lateStarAnchorBand']) {
    assert.equal(isIntentionalClear(field, future), false);
  }
});

test('stuckRescoreCleared(+At) is itself a PROTECTED_FIELD', () => {
  assert.ok(PROTECTED_FIELDS.includes('stuckRescoreCleared'));
  assert.ok(PROTECTED_FIELDS.includes('stuckRescoreClearedAt'));
});

test('restore decision: audit-stuck-rescore-flags.js --fix is NOT reverted by the same-job restore', () => {
  // Reproduces the enrich-reviews.yml shape: audit-stuck-rescore-flags.js --fix
  // deletes needsRescore/rescoreReason/lateStarAnchorBand in the SAME checkout
  // whose HEAD (committed) still carries the stuck flag — the exact
  // "committed has content, local is empty" pattern the restore treats as
  // data loss without this breadcrumb.
  const local = {
    stuckRescoreCleared: true, stuckRescoreClearedAt: stuckRescoreToday,
  };
  const committed = { needsRescore: true, rescoreReason: 'bw-v6-decompression', lateStarAnchorBand: 'B' };
  for (const field of ['needsRescore', 'rescoreReason', 'lateStarAnchorBand']) {
    assert.equal(wouldRestore(field, local, committed), false,
      `stuck ${field} must NOT be resurrected over an intentional clear`);
  }
});

test('stuckRescoreCleared breadcrumb does NOT extend to assignedScore/llmScore (audit-stuck-rescore-flags.js does not clear those)', () => {
  const cleared = { stuckRescoreCleared: true, stuckRescoreClearedAt: stuckRescoreToday };
  assert.equal(isIntentionalClear('assignedScore', cleared), false);
  assert.equal(isIntentionalClear('llmScore', cleared), false);
});

test('a later legitimate needsRescore re-flag is a non-empty write, so no reset path is needed to invalidate the stamp', () => {
  // Unlike wrongProduction (a boolean that can be re-flagged true over a still-
  // fresh auto-clear stamp, requiring invalidateWrongProductionAutoClear),
  // every producer that RE-FLAGS needsRescore writes a real `true` (grep
  // `needsRescore = true` across scripts/). One producer,
  // strip-stale-single-model-scores.js, nulls it instead of deleting/setting
  // true — but it never runs in the same job as audit-stuck-rescore-flags.js
  // --fix, so it can't collide with this stamp inside the freshness window.
  // wouldRestore only fires when the LOCAL field is empty; an ordinary
  // re-flag writes needsRescore=true directly, which is never empty, so the
  // still-fresh stuckRescoreCleared stamp never gets a chance to suppress it.
  const reflagged = {
    needsRescore: true,
    rescoreReason: 'bw-v6-decompression',
    stuckRescoreCleared: true,
    stuckRescoreClearedAt: stuckRescoreToday,
  };
  assert.equal(wouldRestore('needsRescore', reflagged, { needsRescore: false }), false);
});
