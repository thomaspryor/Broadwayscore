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
  it('saveReviewFile in scripts/llm-scoring/index.ts skips the stale-flag clear on the rejection write', () => {
    const src = fs.readFileSync(path.join(__dirname_equiv(), '..', '..', 'scripts', 'llm-scoring', 'index.ts'), 'utf8');
    assert.ok(
      /function saveReviewFile\(filePath: string, data: any, opts:/.test(src),
      'saveReviewFile should accept an opts parameter (skipFailureFlagClear)'
    );
    assert.ok(
      /skipFailureFlagClear/.test(src),
      'saveReviewFile / its rejection-write call site should reference skipFailureFlagClear'
    );
    // The rejection-stamping call site must opt out of the stale-flag clear.
    const rejectionWriteMatch = src.match(/fileData\.rejectionReasoning = rejectionReasoning;[\s\S]{0,200}saveReviewFile\([^)]*\)/);
    assert.ok(rejectionWriteMatch, 'could not locate the rejection-stamping saveReviewFile call');
    assert.ok(
      /skipFailureFlagClear:\s*true/.test(rejectionWriteMatch[0]),
      'the rejection-stamping saveReviewFile call must pass { skipFailureFlagClear: true }'
    );
  });

  function __dirname_equiv() {
    return path.dirname(new URL(import.meta.url).pathname);
  }
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

  it('wicked-2003 WaPo is recovered: rejection cleared, fullText moved to garbageFullText, includable, and scores', () => {
    const { getBestScore } = require('../../scripts/lib/rebuild-helpers.js');
    const data = load(WICKED_WAPO_PATH);
    assert.strictEqual(data.rejectionReason, null);
    assert.strictEqual(data.fullText, null);
    assert.ok(data.garbageFullText && data.garbageFullText.length > 0);
    assert.ok(data.showScoreExcerpt);
    const includable = isIncludableForRebuild(data, { id: data.showId }, WICKED_WAPO_PATH);
    assert.strictEqual(includable, true);
    const best = getBestScore(data);
    assert.ok(best && typeof best.score === 'number', 'wicked-2003 WaPo should have a resolvable score');
  });

  it('wicked-2003 EW alice-king remains rejected (sound not_a_review, documented not recovered)', () => {
    const data = load(EW_ALICE_KING_PATH);
    assert.strictEqual(data.rejectionReason, 'not_a_review');
    assert.strictEqual(data.rejectedBy, 'ensemble-scoreability-check');
  });
});
