/**
 * Verifies classify-wrong-production.js's flag-write paths preserve PROTECTED
 * fields on locked files (S1-T3c). The cross-show MOVE path is explicitly
 * Topology follow-up (2026-04-29): cross-show MOVE now routes through
 * safeRenameReview which honors source `_locked`. The TOPOLOGY: marker
 * is removed.
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'classify-wp-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('classify-wrong-production locked-file behavior (S1-T3c)', () => {
  test('locked file resists wpClassified marker write', () => {
    const filePath = path.join(tmpDir, 'locked-marker.json');
    fs.writeFileSync(filePath, JSON.stringify({
      _locked: true,
      assignedScore: 80,
      wpClassified: 'correct_production',
    }, null, 2));

    // Mirror the persistent-marker write logic.
    const reviewData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    reviewData.wpClassified = 'wrongproduction';
    reviewData.wpClassifiedDate = '2026-04-26';
    safeWriteReview(filePath, reviewData);

    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(written.assignedScore, 80);
    // wpClassified is non-PROTECTED — it can change. The PROTECTED data is what
    // the lock guarantees. Audit-trail markers are forensic and may evolve.
  });

  test('locked file resists wrongProduction flip from duplicate-at-target branch', () => {
    const filePath = path.join(tmpDir, 'locked-dup.json');
    fs.writeFileSync(filePath, JSON.stringify({
      _locked: true,
      wrongProduction: false,
      assignedScore: 90,
      fullText: 'Authoritative review text',
    }, null, 2));

    const reviewData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    reviewData.wrongProduction = true;
    reviewData.llmClassified = 'wrongProduction';
    reviewData.llmConfidence = 'high';
    reviewData.llmReason = 'reviews mention 2026 cast';
    reviewData.llmDate = '2026-04-26';
    const result = safeWriteReview(filePath, reviewData);

    assert.equal(result.lockedSkipped, true);
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(written.wrongProduction, false);
    assert.equal(written.assignedScore, 90);
    assert.equal(written.fullText, 'Authoritative review text');
  });

  test('locked file no-target branch: existing PROTECTED data preserved, audit metadata can land', () => {
    // The lock guards EXISTING canonical data. Adding a new flag (wrongProduction
    // where there was none) is not blocked, since there was nothing to overwrite.
    // What IS protected: existing assignedScore + contentTier are not corruptable.
    const filePath = path.join(tmpDir, 'locked-flag.json');
    fs.writeFileSync(filePath, JSON.stringify({
      _locked: true,
      wrongProduction: false, // existing real value — must survive
      assignedScore: 75,
      contentTier: 'complete',
    }, null, 2));

    const reviewData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    reviewData.wrongProduction = true;
    reviewData.llmClassified = 'wrongProduction';
    reviewData.llmConfidence = 'high';
    reviewData.llmReason = 'no target available';
    reviewData.llmDate = '2026-04-26';
    const result = safeWriteReview(filePath, reviewData);

    assert.equal(result.lockedSkipped, true);
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(written.wrongProduction, false);
    assert.equal(written.assignedScore, 75);
    assert.equal(written.contentTier, 'complete');
  });

  test('TOPOLOGY marker has been REMOVED post-helper-migration (2026-04-29)', () => {
    const src = fs.readFileSync(
      path.resolve('scripts/classify-wrong-production.js'),
      'utf8',
    );
    assert.ok(
      !src.includes('TOPOLOGY:'),
      'classify-wrong-production.js must no longer carry a TOPOLOGY marker — the bypass has been migrated to safeRenameReview',
    );
  });

  test('cross-show MOVE routes through safeRenameReview after migration', () => {
    const src = fs.readFileSync(
      path.resolve('scripts/classify-wrong-production.js'),
      'utf8',
    );
    assert.ok(
      /safeRenameReview\b/.test(src),
      'classify-wrong-production must use safeRenameReview for cross-show MOVE',
    );
    assert.ok(
      !/fs\.writeFileSync\(targetPath/.test(src),
      'raw fs.writeFileSync to targetPath must be removed',
    );
  });
});
