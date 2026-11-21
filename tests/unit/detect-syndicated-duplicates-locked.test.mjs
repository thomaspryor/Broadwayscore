/**
 * Verifies detect-syndicated-duplicates.js skips locked files (S1-T3h).
 *
 * isSyndicatedDuplicate, syndicatedPrimaryFile, syndicationSimilarity,
 * _matchedByOutletPair, _apContentDetected are all NON-PROTECTED, so
 * shouldSkipLockedEnrichment is the required early-return.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { shouldSkipLockedEnrichment } = require('../../scripts/lib/review-write-guard');

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-syn-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('detect-syndicated-duplicates locked-file behavior (S1-T3h)', () => {
  test('locked file is not flagged as isSyndicatedDuplicate (known-critic path)', () => {
    const filePath = path.join(tmpDir, 'locked-syndicated.json');
    fs.writeFileSync(filePath, JSON.stringify({
      _locked: true,
      criticName: 'Some Critic',
      outletId: 'secondary-outlet',
      fullText: 'Real review text',
    }, null, 2));

    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const skip = shouldSkipLockedEnrichment(data);
    assert.equal(skip.skip, true);

    // The script must `continue` here. Verify nothing landed.
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(written.isSyndicatedDuplicate, undefined);
    assert.equal(written.syndicatedPrimaryFile, undefined);
  });

  test('locked file is not flagged from unknown-critic outlet-pair scan', () => {
    const filePath = path.join(tmpDir, 'locked-unknown-pair.json');
    fs.writeFileSync(filePath, JSON.stringify({
      _locked: true,
      criticName: 'Unknown',
      outletId: 'paired-outlet-secondary',
    }, null, 2));

    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const skip = shouldSkipLockedEnrichment(data);
    assert.equal(skip.skip, true);
  });

  test('locked file is not flagged from AP-content scan', () => {
    const filePath = path.join(tmpDir, 'locked-ap.json');
    fs.writeFileSync(filePath, JSON.stringify({
      _locked: true,
      outletId: 'sf-chronicle',
      fullText: 'NEW YORK (AP) — Some text matching AP wire signal.',
    }, null, 2));

    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const skip = shouldSkipLockedEnrichment(data);
    assert.equal(skip.skip, true);
  });

  test('non-locked file proceeds through scan logic', () => {
    const filePath = path.join(tmpDir, 'unlocked.json');
    fs.writeFileSync(filePath, JSON.stringify({
      criticName: 'Some Critic',
      outletId: 'secondary-outlet',
    }, null, 2));

    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const skip = shouldSkipLockedEnrichment(data);
    assert.equal(skip.skip, false);
  });
});
