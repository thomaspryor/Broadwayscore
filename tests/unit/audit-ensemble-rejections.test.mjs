/**
 * BRO-79: audit of the 2026-07-21/22 NYC-rollout ensemble-scoreability-check rescore.
 *
 * Verifies:
 *  - The audit fix list (scripts/audit-bro79-ensemble-rejections.js) is internally
 *    consistent: every null-reason file got a valid enum reason, every FP fix has a
 *    rationale, wicked-2003 WaPo and EW are both accounted for.
 *  - The audit report written to data/audit/bro-79-ensemble-rejection-audit.json (by
 *    running the script against the real ~/broadway-review-texts data) matches the
 *    fix list and shows every recovered/fixed file now passes isIncludableForRebuild().
 *  - The root-cause bug (clearFailureFlags nulling rejectionReason on the same write
 *    that set it) is actually fixed in scripts/llm-scoring/index.ts.
 *
 * If ~/broadway-review-texts isn't present (e.g. a cloud/CI checkout without the
 * private data repo), the live-data assertions are skipped — the fix-list and
 * root-cause-fix assertions still run everywhere.
 *
 * Run: node --test tests/unit/audit-ensemble-rejections.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  NULL_BACKFILL,
  FALSE_POSITIVES,
  WICKED_WAPO_PATH,
  EW_ALICE_KING_PATH,
  REPORT_PATH,
} = require('../../scripts/audit-bro79-ensemble-rejections.js');

const VALID_REASONS = new Set(['wrong_show', 'wrong_production', 'not_a_review', 'garbage_text']);
const REVIEW_TEXTS_ROOT = path.join(os.homedir(), 'broadway-review-texts');
const hasReviewTexts = fs.existsSync(REVIEW_TEXTS_ROOT);
const hasReport = fs.existsSync(REPORT_PATH);

describe('BRO-79 audit fix list — internal consistency', () => {
  it('covers exactly the 26 null-reason files from the 2026-07-21/22 cohort (25 backfilled + wicked-2003 WaPo recovered separately)', () => {
    assert.strictEqual(NULL_BACKFILL.length, 25);
  });

  it('every null-reason backfill uses a valid rejectionReason enum value', () => {
    for (const entry of NULL_BACKFILL) {
      assert.ok(VALID_REASONS.has(entry.reason), `${entry.path}: invalid reason ${entry.reason}`);
      assert.ok(entry.rationale && entry.rationale.length > 20, `${entry.path}: missing rationale`);
    }
  });

  it('has no duplicate paths across the null backfill list', () => {
    const paths = NULL_BACKFILL.map((e) => e.path);
    assert.strictEqual(new Set(paths).size, paths.length);
  });

  it('includes wicked-2003 WaPo covered separately, not in the generic backfill list', () => {
    assert.ok(!NULL_BACKFILL.some((e) => e.path === WICKED_WAPO_PATH));
  });

  it('found exactly 3 confirmed false positives (15% of a 20-file spot-check sample)', () => {
    assert.strictEqual(FALSE_POSITIVES.length, 3);
    for (const fp of FALSE_POSITIVES) {
      assert.ok(['wrong_production', 'not_a_review'].includes(fp.originalReason));
      assert.ok(fp.rationale && fp.rationale.length > 20, `${fp.path}: missing rationale`);
    }
  });
});

describe('BRO-79 root-cause fix — clearFailureFlags no longer self-nulls a fresh rejection', () => {
  const { clearFailureFlags } = require('../../scripts/lib/clear-failure-flags.js');
  const LONG_GARBAGE_TEXT = 'nav menu cookie banner '.repeat(30); // >=500 chars, unscoreable

  it('reproduces the BRO-79 bug: without the option, a freshly-set garbage_text rejectionReason self-nulls', () => {
    const data = { fullText: LONG_GARBAGE_TEXT, rejectionReason: 'garbage_text', rejectedBy: 'ensemble-scoreability-check' };
    clearFailureFlags(data);
    assert.strictEqual(data.rejectionReason, null, 'sanity check: this is the exact bug shape BRO-79 fixed');
  });

  it('skipRejectionReasonClear:true preserves a freshly-set garbage_text rejectionReason', () => {
    const data = { fullText: LONG_GARBAGE_TEXT, rejectionReason: 'garbage_text', rejectedBy: 'ensemble-scoreability-check' };
    const cleared = clearFailureFlags(data, { skipRejectionReasonClear: true });
    assert.strictEqual(data.rejectionReason, 'garbage_text');
    assert.strictEqual(data.rejectedBy, 'ensemble-scoreability-check');
    assert.ok(!cleared.includes('rejectionReason'));
  });

  it('skipRejectionReasonClear:true still clears every OTHER stale flag on the same write (narrow skip, not a blanket one)', () => {
    const data = {
      fullText: LONG_GARBAGE_TEXT,
      rejectionReason: 'garbage_text',
      incompleteReason: 'no_url',
      url: 'https://example.com/review',
      scoreStatus: 'TO_BE_CALCULATED',
      llmScore: { score: 50 },
      serpRetryCount: 3,
    };
    const cleared = clearFailureFlags(data, { skipRejectionReasonClear: true });
    assert.strictEqual(data.rejectionReason, 'garbage_text', 'rejectionReason itself must survive');
    assert.strictEqual(data.incompleteReason, null, 'unrelated stale flags must still clear');
    assert.strictEqual(data.scoreStatus, null);
    assert.strictEqual(data.serpRetryCount, null);
    assert.ok(cleared.includes('incompleteReason'));
    assert.ok(cleared.includes('scoreStatus'));
    assert.ok(cleared.includes('serpRetryCount'));
  });

  it('does not skip the clear for a STALE garbage_text rejection carried over from a prior run (skipRejectionReasonClear defaults to false)', () => {
    // A caller that is NOT the fresh-rejection write path (i.e. every other
    // saveReviewFile call) must keep clearing a real stale flag.
    const data = { fullText: LONG_GARBAGE_TEXT, rejectionReason: 'garbage_text', rejectedBy: 'ensemble-scoreability-check' };
    clearFailureFlags(data); // no opts — default behavior
    assert.strictEqual(data.rejectionReason, null);
  });

  it('scripts/llm-scoring/index.ts wires the rejection-stamping saveReviewFile call to skipRejectionReasonClear', () => {
    // Lightweight wiring check (behavior itself is covered by the tests above,
    // which exercise clearFailureFlags directly) — just confirms the call site
    // that sets rejectionReason also passes the option, so a future refactor
    // that silently drops the option still gets caught by the behavioral tests
    // above failing, and this catches an accidental disconnection of the two.
    const srcPath = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'scripts', 'llm-scoring', 'index.ts');
    const src = fs.readFileSync(srcPath, 'utf8');
    const rejectionWriteMatch = src.match(/fileData\.rejectionReasoning = rejectionReasoning;[\s\S]{0,200}saveReviewFile\([^)]*\)/);
    assert.ok(rejectionWriteMatch, 'could not locate the rejection-stamping saveReviewFile call');
    assert.ok(
      /skipRejectionReasonClear:\s*true/.test(rejectionWriteMatch[0]),
      'the rejection-stamping saveReviewFile call must pass { skipRejectionReasonClear: true }'
    );
  });
});

describe('BRO-79 audit report (requires ~/broadway-review-texts + prior script run)', { skip: !hasReport }, () => {
  const report = hasReport ? JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8')) : null;

  it('report accounts for all 26 null-reason files, 3 false positives, wicked recovery, EW documentation', () => {
    assert.strictEqual(report.nullReasonBackfill.length, 25);
    assert.strictEqual(report.falsePositivesFixed.length, 3);
    assert.ok(report.wickedRecovery);
    assert.ok(report.ewAliceKingDocumented);
  });

  it('wicked-2003 WaPo was recovered via excerpt-tier scoring with a real score', () => {
    assert.strictEqual(report.wickedRecovery.path, WICKED_WAPO_PATH);
    assert.strictEqual(typeof report.wickedRecovery.llmScore, 'number');
    assert.ok(report.wickedRecovery.llmScore >= 1 && report.wickedRecovery.llmScore <= 100);
  });

  it('EW alice-king was verified and documented as a sound not_a_review rejection', () => {
    assert.strictEqual(report.ewAliceKingDocumented.path, EW_ALICE_KING_PATH);
    assert.strictEqual(report.ewAliceKingDocumented.verdict, 'sound-rejection-confirmed');
  });
});

describe('BRO-79 live data state (requires ~/broadway-review-texts)', { skip: !hasReviewTexts }, () => {
  const { isIncludableForRebuild } = require('../../scripts/lib/review-guards.js');

  function load(relPath) {
    return JSON.parse(fs.readFileSync(path.join(REVIEW_TEXTS_ROOT, relPath), 'utf8'));
  }

  it('no audited null-reason file still has rejectionReason===null', () => {
    for (const entry of NULL_BACKFILL) {
      const data = load(entry.path);
      assert.notStrictEqual(data.rejectionReason, null, `${entry.path} still has a null rejectionReason`);
      assert.strictEqual(data.rejectionReason, entry.reason);
    }
  });

  it('all 3 false-positive fixes cleared their ensemble rejection', () => {
    for (const fp of FALSE_POSITIVES) {
      const data = load(fp.path);
      assert.strictEqual(data.rejectionReason, null, `${fp.path} should have rejectionReason cleared`);
      assert.strictEqual(data.rejectedBy, null, `${fp.path} should have rejectedBy cleared`);
      const result = isIncludableForRebuild(data, { id: data.showId }, fp.path);
      assert.strictEqual(result, true, `${fp.path} should now be includable`);
    }
  });

  it('old-times-2015 huffpost FP also had wrongProduction manually cleared', () => {
    const data = load('old-times-2015/huffpost--michael-glitz.json');
    assert.strictEqual(data.wrongProduction, false);
    assert.strictEqual(data.wrongProductionManualClear, true);
  });

  it('wicked-2003 WaPo is recovered: rejection cleared, fullText archived outside garbageFullText (so rebuild does not auto-restore the contamination), includable, and scores', () => {
    const { getBestScore, applyScoreRelevantMigrations } = require('../../scripts/lib/rebuild-helpers.js');
    const data = load(WICKED_WAPO_PATH);
    assert.strictEqual(data.rejectionReason, null);
    assert.strictEqual(data.fullText, null);
    // Must NOT be garbageFullText: rebuild-helpers.js's applyScoreRelevantMigrations()
    // auto-restores garbageFullText into fullText via cleanText() whenever fullText is
    // empty and garbageReason isn't an error/404 page — cleanText() does not strip the
    // WaPo homepage junk here, so that migration would silently undo this recovery.
    assert.strictEqual(data.garbageFullText, undefined);
    assert.ok(data.bro79ContaminatedFullTextArchive && data.bro79ContaminatedFullTextArchive.length > 0);
    assert.ok(data.showScoreExcerpt);
    const includable = isIncludableForRebuild(data, { id: data.showId }, WICKED_WAPO_PATH);
    assert.strictEqual(includable, true);
    const best = getBestScore(data);
    assert.ok(best && typeof best.score === 'number', 'wicked-2003 WaPo should have a resolvable score');
    // Simulate the actual rebuild migration step and confirm fullText stays cleared.
    const migrated = { ...data };
    applyScoreRelevantMigrations(migrated);
    assert.strictEqual(migrated.fullText, null, 'rebuild must not auto-restore the contaminated text back into fullText');
  });

  it('wicked-2003 EW alice-king remains rejected (sound not_a_review, documented not recovered)', () => {
    const data = load(EW_ALICE_KING_PATH);
    assert.strictEqual(data.rejectionReason, 'not_a_review');
    assert.strictEqual(data.rejectedBy, 'ensemble-scoreability-check');
  });
});
