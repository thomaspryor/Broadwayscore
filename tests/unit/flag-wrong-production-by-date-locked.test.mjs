/**
 * Verifies flag-wrong-production-by-date.js's per-file write path honors
 * _locked. The script writes wrongProduction + wrongProductionNote (both
 * PROTECTED) via safeWriteReview, so the writer's lockedOverride is the
 * sole protection — no shouldSkipLockedEnrichment needed.
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flag-wrong-prod-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('flag-wrong-production-by-date locked-file behavior', () => {
  test('locked file with wrongProduction:false stays unchanged when script flips to true', () => {
    const filePath = path.join(tmpDir, 'locked-review.json');
    fs.writeFileSync(filePath, JSON.stringify({
      showId: 'joe-turners-come-and-gone-2026',
      _locked: true,
      wrongProduction: false,
      wrongProductionNote: 'manually verified — correct production',
      assignedScore: 85,
    }, null, 2));

    // Simulate the script's per-file write logic (the snippet from
    // scripts/flag-wrong-production-by-date.js inside the !DRY_RUN block).
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    data.wrongProduction = true;
    data.wrongProductionNote = 'Date guard: review 2009-04-09 is 6210d before … (preview/open)';
    const result = safeWriteReview(filePath, data);

    // Lock should preserve the original PROTECTED values.
    assert.equal(result.lockedSkipped, true);
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(written.wrongProduction, false);
    assert.equal(written.wrongProductionNote, 'manually verified — correct production');
    assert.equal(written.assignedScore, 85);
  });

  test('non-locked file with wrongProduction:false flips to true normally', () => {
    const filePath = path.join(tmpDir, 'unlocked-review.json');
    fs.writeFileSync(filePath, JSON.stringify({
      showId: 'some-show-2026',
      wrongProduction: false,
    }, null, 2));

    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    data.wrongProduction = true;
    data.wrongProductionNote = 'Date guard hit';
    const result = safeWriteReview(filePath, data);

    assert.equal(result.lockedSkipped, false);
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(written.wrongProduction, true);
    assert.equal(written.wrongProductionNote, 'Date guard hit');
  });
});
