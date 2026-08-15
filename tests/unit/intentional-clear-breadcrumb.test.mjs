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

// ── Which loop can actually consume a breadcrumb? (BRO-1624 follow-up) ──
//
// The original form of the test below asserted that EVERY CLEAR_BREADCRUMBS key
// must be in PROTECTED_FIELDS, on the premise that "the restore loop only
// iterates PROTECTED fields". That premise is true of only SOME consumers.
// There are two structurally different loops, and they differ in what they
// iterate:
//
//   LOOP 1 — "preserve" (review-write-guard.js safeWriteReview, ~line 1005) and
//     the git-level push-restore (.github/actions/push-review-texts/action.yml
//     ~line 166) and checkForDataLoss (~line 1359). These iterate
//     getEffectiveProtectedFields(existing) / PROTECTED_FIELDS ∪ ACTION_EXTRA —
//     i.e. PROTECTED fields only. A breadcrumb for an unprotected field is
//     unreachable here.
//
//   LOOP 2 — "merge" (review-write-guard.js safeWriteReview, ~line 1053):
//     `for (const [key, val] of Object.entries(existing))` — EVERY key already
//     on disk, protected or not — and it consults clearHonored(key) →
//     isIntentionalClear. A breadcrumb IS meaningful here for an unprotected
//     field: without it, a write that deletes the key gets it merged straight
//     back from disk.
//
// So the correct invariant is not "breadcrumb ⇒ protected" but "breadcrumb ⇒
// reachable by at least one loop, and deliberately classified". Unprotected
// breadcrumb keys are allowlisted below so adding a new one stays a conscious
// decision rather than an accident.
//
// duplicateTextOf is deliberately NOT protected. It cannot be promoted into
// PROTECTED_FIELDS, because scripts/backfill-review-flags.js (~line 207) deletes
// a stale duplicateTextOf WITHOUT stamping duplicateClearReason, and
// .github/workflows/weekly-integrity.yml runs it weekly and then pushes through
// push-review-texts. Protecting the field would make the git-level restore
// resurrect the pointer that cleanup just removed — turning the weekly stale-
// pointer sweep into a permanent no-op, which is precisely the
// "Protected-N-from-data-loss, pushed nothing" failure the action.yml comment
// block describes for the original stale-duplicateOf incident.
const MERGE_PATH_ONLY_BREADCRUMBS = new Set(['duplicateTextOf']);

test('every CLEAR_BREADCRUMBS key is reachable by a loop that consults it', () => {
  for (const field of Object.keys(CLEAR_BREADCRUMBS)) {
    if (MERGE_PATH_ONLY_BREADCRUMBS.has(field)) {
      // Allowlisted: reachable via LOOP 2 only. Assert the classification is
      // honest — if someone later protects it, the allowlist entry is stale and
      // must be removed rather than left to rot.
      assert.ok(!PROTECTED_FIELDS.includes(field),
        `'${field}' is allowlisted as merge-path-only but IS in PROTECTED_FIELDS — drop it from MERGE_PATH_ONLY_BREADCRUMBS`);
      continue;
    }
    assert.ok(PROTECTED_FIELDS.includes(field),
      `CLEAR_BREADCRUMBS has '${field}' but it is not in PROTECTED_FIELDS (and is not allowlisted as merge-path-only)`);
  }
});

test('merge-path-only breadcrumbs are NOT relied on by the push-restore path', () => {
  // Documents the limitation of the allowlist: LOOP 1 (the git-level restore)
  // never iterates these fields, so wouldRestore() — which mirrors LOOP 1 — is
  // structurally unable to protect them either way. This is the trade-off
  // accepted above, asserted so it is visible rather than assumed.
  for (const field of MERGE_PATH_ONLY_BREADCRUMBS) {
    assert.ok(!PROTECTED_FIELDS.includes(field),
      `${field} must stay unprotected for the weekly stale-pointer sweep to work`);
  }
});

test('BRO-1624 regression: a merge-path-only breadcrumb actually suppresses the merge-back', async () => {
  // Behavioural lock, not a shape assertion. Deleting the duplicateTextOf entry
  // from CLEAR_BREADCRUMBS makes this test fail — which is the point: the entry
  // is load-bearing even though the field is unprotected, so "it's not in
  // PROTECTED_FIELDS, therefore it's dead code" must never be acted on again.
  const fs = require('node:fs');
  const os = require('node:os');
  const { safeWriteReview } = require(path.join(repoRoot, 'scripts/lib/review-write-guard.js'));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dtof-breadcrumb-'));
  try {
    const showDir = path.join(tmp, 'some-show-2026');
    fs.mkdirSync(showDir, { recursive: true });
    const file = path.join(showDir, 'variety--jane-doe.json');
    // The sibling must EXIST, or safeWriteReview's dangling-pointer self-heal
    // deletes duplicateTextOf for an unrelated reason and the test proves nothing.
    fs.writeFileSync(path.join(showDir, 'nyt--x.json'),
      JSON.stringify({ outlet: 'NYT', url: 'https://nyt.com/x', fullText: 'text' }));

    const onDisk = {
      outlet: 'Variety', critic: 'Jane Doe', url: 'https://variety.com/a',
      fullText: 'text', duplicateTextOf: 'nyt--x.json',
    };

    // (a) delete WITH the breadcrumb → the clear sticks.
    fs.writeFileSync(file, JSON.stringify(onDisk));
    safeWriteReview(file, {
      outlet: 'Variety', critic: 'Jane Doe', url: 'https://variety.com/a', fullText: 'text',
      duplicateClearReason: 'audit-duplicate-of-url-mismatch --fix: url mismatch',
    });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).duplicateTextOf, undefined,
      'a stamped delete of duplicateTextOf must survive the merge loop');

    // (b) delete WITHOUT a breadcrumb → data-loss protection restores it.
    fs.writeFileSync(file, JSON.stringify(onDisk));
    safeWriteReview(file, {
      outlet: 'Variety', critic: 'Jane Doe', url: 'https://variety.com/a', fullText: 'text',
    });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).duplicateTextOf, 'nyt--x.json',
      'an unstamped delete of duplicateTextOf must be merged back (data-loss protection)');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
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
