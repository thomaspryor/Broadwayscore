/**
 * Integration tests for scripts/verify-all-scored.js (Gap 1 — Lost Boys
 * 2026-04-26 #8 defense).
 *
 * Builds a synthetic data/review-texts/{showId}/ directory with one orphan
 * file (fullText present, no assignedScore) and several distractors, and
 * asserts the auditShow walker flags exactly the orphan and skips
 * everything else for the documented reason.
 *
 * Pure-helper tests cover isScoreableSurvivor's exclusion-flag matrix
 * (wrongProduction, wrongShow, wrongAttribution, isRoundupArticle,
 * duplicateOf, rejectionReason, contentTier=invalid).
 *
 * Run: node --test tests/unit/verify-all-scored.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const verifyAllScoredPath = require.resolve('../../scripts/verify-all-scored.js');

// We import the helpers directly. auditShow reads from REPO_ROOT/data/review-texts —
// the synthetic-show test below temporarily redirects review-texts via a tmpdir
// + fs.readdirSync wrapper isn't possible without a constructor. Instead we
// stage the synthetic show INSIDE the real review-texts dir under an obviously-
// fake show id (`__synthetic-orphan-test-show-id__`), audit it, and clean up.
const { isScoreableSurvivor, hasValidScore, isWithinWindow, auditShow } = require(
  verifyAllScoredPath,
);

// ─── isScoreableSurvivor — exclusion matrix ─────────────────────────────────

// isScoreableSurvivor delegates to canonical isIncludableForRebuild — these
// tests verify the delegation, not the predicate's full matrix (that's
// covered exhaustively by tests/unit/is-includable-for-rebuild.test.mjs).

test('eligible: substantive fullText, no exclusion flags', () => {
  const data = { fullText: 'a'.repeat(500) };
  const r = isScoreableSurvivor(data, {});
  assert.equal(r.eligible, true);
});

test('skip: wrongProduction without manual clear', () => {
  const r = isScoreableSurvivor(
    { fullText: 'a'.repeat(500), wrongProduction: true },
    {},
  );
  assert.equal(r.eligible, false);
  assert.equal(r.reason, 'not-includable-by-rebuild');
});

test('eligible: wrongProduction WITH manual clear (rebuild includes it)', () => {
  // Codex caught this drift: bespoke "skip if wrongProduction=true" predicate
  // would miss real orphans where rebuild-helpers includes the file via
  // wrongProductionManualClear / wrongProductionOverride / humanReviewedWrongProduction=false.
  const r = isScoreableSurvivor(
    { fullText: 'a'.repeat(500), wrongProduction: true, wrongProductionManualClear: true },
    {},
  );
  assert.equal(r.eligible, true);
});

test('skip: wrongAttribution', () => {
  const r = isScoreableSurvivor(
    { fullText: 'a'.repeat(500), wrongAttribution: true },
    {},
  );
  assert.equal(r.eligible, false);
});

test('skip: duplicateOf points to canonical', () => {
  const r = isScoreableSurvivor(
    { fullText: 'a'.repeat(500), duplicateOf: 'other-file.json' },
    {},
  );
  assert.equal(r.eligible, false);
});

test('skip: rejectionReason is set without re-fetch', () => {
  const r = isScoreableSurvivor(
    { fullText: 'a'.repeat(500), rejectionReason: 'paywall', rejectedAt: '2026-04-26T00:00:00Z' },
    {},
  );
  assert.equal(r.eligible, false);
});

test('skip: contentTier=invalid (no manual clear)', () => {
  const r = isScoreableSurvivor(
    { fullText: 'a'.repeat(500), contentTier: 'invalid' },
    {},
  );
  assert.equal(r.eligible, false);
});

test('skip: no text, no aggregator signal — rebuild excludes', () => {
  const r = isScoreableSurvivor({ fullText: '' }, {});
  assert.equal(r.eligible, false);
});

test('eligible: short fullText BUT originalScore present (rebuild includes)', () => {
  // isIncludableForRebuild's content gate (line 1827) accepts originalScore
  // as an aggregator signal. A short stub with originalScore set is
  // includable.
  const r = isScoreableSurvivor(
    { fullText: '', originalScore: '4/5' },
    {},
  );
  assert.equal(r.eligible, true);
});

test('eligible: fullTextWrongAuthor + stagedoorExcerpt — Codex finding', () => {
  // Codex flagged this as a likely false-negative in the original bespoke
  // predicate. isIncludableForRebuild line 1815-1823 explicitly handles it.
  const r = isScoreableSurvivor(
    {
      fullText: 'a'.repeat(500),
      fullTextWrongAuthor: true,
      stagedoorExcerpt: 'critic praised the production',
    },
    {},
  );
  assert.equal(r.eligible, true);
});

// ─── hasValidScore ──────────────────────────────────────────────────────────

test('hasValidScore: any source-of-truth field in 1-100 passes', () => {
  // Each rebuild precedence path independently makes a file scored.
  assert.equal(hasValidScore({ humanReviewScore: 75 }), true);
  assert.equal(hasValidScore({ adjudicatedScore: 60 }), true);
  assert.equal(hasValidScore({ originalScoreNormalized: 80 }), true);
  assert.equal(hasValidScore({ originalScore: '4/5 stars' }), true);
  assert.equal(hasValidScore({ llmScore: { score: 67 } }), true);
  // Out-of-range / wrong type fails.
  assert.equal(hasValidScore({ humanReviewScore: 0 }), false);
  assert.equal(hasValidScore({ humanReviewScore: 101 }), false);
  assert.equal(hasValidScore({ humanReviewScore: '75' }), false);
  assert.equal(hasValidScore({ llmScore: { score: 'mixed' } }), false);
  assert.equal(hasValidScore({ llmScore: null }), false);
  // assignedScore is rebuild OUTPUT, not source-of-truth — must NOT count.
  // 2026-04-27 ship-check caught the original predicate falsely flagging 5
  // Beaches reviews because llmScore.score was set but assignedScore wasn't.
  assert.equal(hasValidScore({ assignedScore: 75 }), false);
  assert.equal(hasValidScore({}), false);
});

test('hasValidScore: empty originalScore string is NOT a score', () => {
  assert.equal(hasValidScore({ originalScore: '' }), false);
  assert.equal(hasValidScore({ originalScore: '   ' }), false);
});

test('hasValidScore: regression — Chris Jones Beaches 2026-04-27 case', () => {
  // Source file had llmScore.score=67 but no assignedScore on the per-file
  // JSON. Original predicate flagged this as orphan-unscored; correct
  // predicate recognizes the LLM score.
  const data = {
    outletId: 'chicagotribune',
    criticName: 'Chris Jones',
    fullText: 'a'.repeat(4188),
    llmScore: { score: 67 },
  };
  assert.equal(hasValidScore(data), true);
});

test('hasValidScore: humanReviewScoreProvisional skips P0 (round-2 Codex P1)', () => {
  // Rebuild's getBestScore (rebuild-helpers.js:345-350) skips the human
  // score when provisional===true — the operator wrote a tentative number
  // but wants the LLM to override. A file with ONLY a provisional human
  // score is unscored by rebuild and must be flagged as orphan.
  assert.equal(
    hasValidScore({ humanReviewScore: 75, humanReviewScoreProvisional: true }),
    false,
  );
  // But provisional + an llmScore.score is fine — P1 fires.
  assert.equal(
    hasValidScore({
      humanReviewScore: 75,
      humanReviewScoreProvisional: true,
      llmScore: { score: 67 },
    }),
    true,
  );
  // Non-provisional human score (default) wins.
  assert.equal(
    hasValidScore({ humanReviewScore: 75, humanReviewScoreProvisional: false }),
    true,
  );
  assert.equal(hasValidScore({ humanReviewScore: 75 }), true);
});

test('hasValidScore: respects originalScoreCleared (round-2 P2)', () => {
  // Rebuild's getBestScore (rebuild-helpers.js:413-430) skips P0.5 when
  // originalScoreCleared===true. The audit must do the same — otherwise
  // a deliberately-cleared score looks "valid" here but rebuild excludes
  // it from the composite, producing a silent false-negative orphan.
  // Tier-1.5 override (clear reason starts with 'extraction-no-evidence')
  // is rebuild's exception path; the audit conservatively defers to
  // rebuild for that case via isIncludableForRebuild upstream.
  const cleared = {
    originalScore: '4/5',
    originalScoreNormalized: 80,
    originalScoreCleared: true,
  };
  // No other score signal — should NOT pass.
  assert.equal(hasValidScore(cleared), false);
  // But humanReviewScore on a cleared file still wins (P0).
  assert.equal(hasValidScore({ ...cleared, humanReviewScore: 75 }), true);
  // And llmScore on a cleared file still wins (P1).
  assert.equal(hasValidScore({ ...cleared, llmScore: { score: 67 } }), true);
});

// ─── isWithinWindow ─────────────────────────────────────────────────────────

test('isWithinWindow: ±N day window', () => {
  const now = new Date('2026-04-27T12:00:00Z');
  assert.equal(isWithinWindow('2026-04-27', now, 7), true);
  assert.equal(isWithinWindow('2026-04-21', now, 7), true);  // 6d before
  assert.equal(isWithinWindow('2026-05-04', now, 7), true);  // 7d after
  assert.equal(isWithinWindow('2026-05-05', now, 7), false); // 8d after
  assert.equal(isWithinWindow('2026-04-19', now, 7), false); // 8d before
  assert.equal(isWithinWindow(null, now, 7), false);
  assert.equal(isWithinWindow('not-a-date', now, 7), false);
});

// ─── Integration: synthetic show directory ──────────────────────────────────

const SYNTHETIC_SHOW_ID = '__synthetic-orphan-test-show__';
const REPO_ROOT = path.resolve(path.dirname(verifyAllScoredPath), '..');
const SYNTHETIC_SHOW_DIR = path.join(REPO_ROOT, 'data', 'review-texts', SYNTHETIC_SHOW_ID);

function writeReview(filename, payload) {
  fs.writeFileSync(
    path.join(SYNTHETIC_SHOW_DIR, filename),
    JSON.stringify(payload, null, 2) + '\n',
  );
}

test('integration: synthetic show with 1 orphan + 5 distractors flags exactly the orphan', () => {
  // Set up the fake show directory. Avoid os.tmpdir because verify-all-scored
  // hard-codes REPO_ROOT/data/review-texts.
  fs.mkdirSync(SYNTHETIC_SHOW_DIR, { recursive: true });
  try {
    // Distractor 1: scored properly via humanReviewScore → skip.
    writeReview('nytimes--helen-shaw.json', {
      outletId: 'nytimes',
      criticName: 'Helen Shaw',
      fullText: 'a'.repeat(800),
      humanReviewScore: 78,
    });

    // Distractor 1b: scored via llmScore (mirrors Chris Jones Beaches
    // 2026-04-27 — the case that exposed the assignedScore bug).
    writeReview('time-out--adam-feldman.json', {
      outletId: 'timeout',
      criticName: 'Adam Feldman',
      fullText: 'b'.repeat(800),
      llmScore: { score: 67 },
    });

    // Distractor 2: wrongProduction → skip.
    writeReview('variety--charles-isherwood.json', {
      outletId: 'variety',
      criticName: 'Charles Isherwood',
      fullText: 'b'.repeat(800),
      wrongProduction: true,
    });

    // Distractor 3: contentTier=invalid → skip.
    writeReview('hollywood-reporter--david-rooney.json', {
      outletId: 'hollywood-reporter',
      criticName: 'David Rooney',
      fullText: 'c'.repeat(800),
      contentTier: 'invalid',
    });

    // Distractor 4: empty text + no aggregator signal → rebuild excludes
    // (and so do we). Matches the orchestrator's "stub-only" pre-discovery
    // state.
    writeReview('amny--matt-windman-stub.json', {
      outletId: 'amny',
      criticName: 'Matt Windman',
      fullText: '',
    });

    // Distractor 5: duplicateOf set → skip (this is how dedup works).
    writeReview('time-out--adam-feldman-syndication.json', {
      outletId: 'timeout',
      criticName: 'Adam Feldman (Syndicated)',
      fullText: 'd'.repeat(800),
      duplicateOf: 'time-out--adam-feldman.json',
    });

    // The orphan: substantive fullText, no exclusion flags, no score.
    // Mirrors Lost Boys 2026-04-26 amNY Matt Windman + Exeunt Loren Noveck.
    writeReview('exeunt-magazine--loren-noveck.json', {
      outletId: 'exeunt-magazine',
      criticName: 'Loren Noveck',
      url: 'https://exeunt.example/lost-boys-review',
      fullText: 'e'.repeat(900),
      // Deliberately: no assignedScore, no humanReviewScore, no llmScore.
    });

    const result = auditShow(SYNTHETIC_SHOW_ID);
    assert.equal(result.totalScanned, 7, 'should count all 7 staged files');
    // Eligible scanned = 3: Helen Shaw (humanReviewScore), Adam Feldman
    // (llmScore — the Beaches regression case), Loren Noveck (orphan).
    assert.equal(result.eligibleScanned, 3);
    assert.equal(result.orphans.length, 1, 'exactly one orphan-unscored');
    const orphan = result.orphans[0];
    assert.equal(orphan.outletId, 'exeunt-magazine');
    assert.equal(orphan.criticName, 'Loren Noveck');
    // No score in any source-of-truth field.
    assert.equal(orphan.humanReviewScore, null);
    assert.equal(orphan.llmScore, null);
    assert.equal(orphan.originalScore, null);
    assert.equal(orphan.fullTextLen, 900);
  } finally {
    // Clean up — never leave fake show dirs in review-texts.
    fs.rmSync(SYNTHETIC_SHOW_DIR, { recursive: true, force: true });
  }
});

test('integration: empty/missing show directory returns empty orphan list', () => {
  // Audit a show that doesn't exist under review-texts/. auditShow swallows
  // ENOENT and returns the empty result.
  const result = auditShow('__definitely-not-a-real-show-id__');
  assert.equal(result.totalScanned, 0);
  assert.equal(result.orphans.length, 0);
});

test('integration: corrupt JSON in show directory surfaces as orphan with corrupt flag', () => {
  fs.mkdirSync(SYNTHETIC_SHOW_DIR, { recursive: true });
  try {
    fs.writeFileSync(path.join(SYNTHETIC_SHOW_DIR, 'broken--file.json'), '{not: valid json');
    // Plus a healthy distractor so the directory isn't empty in case of
    // future early-exit logic.
    writeReview('nytimes--ok.json', {
      outletId: 'nytimes',
      criticName: 'Helen Shaw',
      fullText: 'a'.repeat(800),
      humanReviewScore: 78,
    });
    const result = auditShow(SYNTHETIC_SHOW_ID);
    assert.equal(result.orphans.length, 1);
    assert.deepEqual(result.orphans[0].fileFlags, { corrupt: true });
  } finally {
    fs.rmSync(SYNTHETIC_SHOW_DIR, { recursive: true, force: true });
  }
});
