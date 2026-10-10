/**
 * Verifies classify-non-reviews.js's per-file write path preserves PROTECTED
 * fields on locked files (S1-T3i).
 *
 * The script's three safeWriteReview call sites mutate non-PROTECTED flags
 * (isNonReview, nonReviewType, classifiedAt). lockedOverride from S1-T1
 * preserves PROTECTED fields (assignedScore, fullText, etc.) on locked files
 * even when the script tries to flip the non-PROTECTED flags.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { safeWriteReview } = require('../../scripts/lib/review-write-guard');

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'classify-non-reviews-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('classify-non-reviews locked-file behavior (S1-T3i)', () => {
  test('--reclassify-flagged path preserves PROTECTED fields on locked file', () => {
    const filePath = path.join(tmpDir, 'reclassify-locked.json');
    fs.writeFileSync(filePath, JSON.stringify({
      _locked: true,
      isNonReview: true,
      nonReviewType: 'announcement',
      assignedScore: 90,
      fullText: 'Critic-confirmed real review text',
      contentTier: 'complete',
    }, null, 2));

    // Mirror the script's reclassify logic: clear the flag, null the type,
    // stamp the classifier, write via safeWriteReview.
    const fresh = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    fresh.isNonReview = false;
    fresh.nonReviewClearedNote = '[2026-04-26 cleared stale isNonReview]';
    if (fresh.nonReviewType) {
      fresh.nonReviewTypePrev = fresh.nonReviewType;
      fresh.nonReviewType = null;
    }
    fresh.classifiedAt = '2026-04-26T00:00:00Z';
    fresh.nonReviewClassifiedBy = 'gpt:reclassify-audit';
    safeWriteReview(filePath, fresh);

    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    // PROTECTED fields preserved by lockedOverride.
    assert.equal(written.assignedScore, 90);
    assert.equal(written.fullText, 'Critic-confirmed real review text');
    assert.equal(written.contentTier, 'complete');
    // Non-PROTECTED flags can change (the audit's intent — correcting misclassification).
    assert.equal(written.isNonReview, false);
    assert.equal(written.nonReviewType, null);
  });

  test('apply-flags path preserves PROTECTED fields on locked file', () => {
    const filePath = path.join(tmpDir, 'apply-locked.json');
    fs.writeFileSync(filePath, JSON.stringify({
      _locked: true,
      assignedScore: 75,
      fullText: 'Real review text on a locked file',
    }, null, 2));

    // Mirror the apply-flags logic.
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    data.isNonReview = true;
    data.nonReviewType = 'profile';
    data.nonReviewClassifiedBy = 'gpt';
    data.classifiedAt = '2026-04-26T00:00:00Z';
    safeWriteReview(filePath, data);

    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(written.assignedScore, 75);
    assert.equal(written.fullText, 'Real review text on a locked file');
    // The non-PROTECTED isNonReview flag can flip — that's by design.
    assert.equal(written.isNonReview, true);
  });

  test('zero raw writes to review-texts paths in classify-non-reviews.js', () => {
    // Acceptance criterion from the plan's S1-T3i.
    const src = fs.readFileSync(
      path.resolve('scripts/classify-non-reviews.js'),
      'utf8',
    );
    // The two remaining fs.writeFileSync calls target AUDIT_DIR (audit reports),
    // not REVIEW_TEXTS_DIR. Both paths assigned via path.join(AUDIT_DIR, ...).
    const writeFileSyncMatches = src.matchAll(/fs\.writeFileSync\(([^,]+),/g);
    for (const m of writeFileSyncMatches) {
      const target = m[1].trim();
      // The script's review-texts writes are routed through safeWriteReview;
      // any remaining fs.writeFileSync target should reference AUDIT_DIR/audit.
      assert.ok(
        target === 'reportPath' || target === 'OUTPUT_FILE' || target === 'latestPath',
        `Unexpected fs.writeFileSync target: ${target}`,
      );
    }
  });
});
