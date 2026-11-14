/**
 * Verifies backfill-unknown-critics.js skips locked files entirely (S1-T3e).
 *
 * criticName + outletId are NOT in PROTECTED_FIELDS, so safeWriteReview's
 * lockedOverride doesn't block them. shouldSkipLockedEnrichment is the
 * required early-return for the per-file update.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { updateReviewFile } = require('../../scripts/backfill-unknown-critics');

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-critics-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('backfill-unknown-critics locked-file behavior (S1-T3e)', () => {
  test('locked file is skipped — criticName unchanged', () => {
    // Set up a fake review-texts/dir/file structure since updateReviewFile
    // computes the new path inside reviewsDir.
    const showDir = path.join(tmpDir, 'review-texts', 'some-show');
    fs.mkdirSync(showDir, { recursive: true });
    const filePath = path.join(showDir, 'unknown--unknown.json');
    fs.writeFileSync(filePath, JSON.stringify({
      _locked: true,
      criticName: 'Manually Verified Critic',
      outletId: 'unknown',
      url: 'https://www.example.com/review/x',
    }, null, 2));

    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const result = updateReviewFile(filePath, 'some-show', 'unknown--unknown.json', 'nytimes', 'Replacement Critic', data);

    assert.equal(result.lockedSkipped, true);
    assert.equal(result.renamed, false);

    // File on disk still has the manually-verified critic.
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(written.criticName, 'Manually Verified Critic');
    assert.equal(written.outletId, 'unknown');
  });

  test('TOPOLOGY marker has been REMOVED post-helper-migration (2026-04-29)', () => {
    const src = fs.readFileSync(
      path.resolve('scripts/backfill-unknown-critics.js'),
      'utf8',
    );
    assert.ok(
      !src.includes('TOPOLOGY:'),
      'backfill-unknown-critics.js must no longer carry a TOPOLOGY marker — the bypass has been migrated to safeRenameReview',
    );
  });

  test('rename path routes through safeRenameReview after migration', () => {
    const src = fs.readFileSync(
      path.resolve('scripts/backfill-unknown-critics.js'),
      'utf8',
    );
    assert.ok(
      /safeRenameReview\b/.test(src),
      'backfill-unknown-critics must use safeRenameReview for the rename path',
    );
    assert.ok(
      !/fs\.writeFileSync\(newPath/.test(src),
      'raw fs.writeFileSync to newPath must be removed',
    );
  });
});
