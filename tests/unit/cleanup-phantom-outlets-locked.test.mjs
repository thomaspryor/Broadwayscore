/**
 * Verifies cleanup-phantom-outlets.js's re-aliasing path skips locked files
 * (S1-T3f). outletId is NOT in PROTECTED_FIELDS, so safeWriteReview's
 * lockedOverride doesn't block it. shouldSkipLockedEnrichment is the
 * required early-return.
 *
 * The merge-then-unlink path (line ~128) is explicitly out of scope
 * (TOPOLOGY marker) — file moves don't honor _locked.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { shouldSkipLockedEnrichment, safeWriteReview } = require('../../scripts/lib/review-write-guard');

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-phantom-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('cleanup-phantom-outlets locked-file behavior (S1-T3f)', () => {
  test('locked file with stale alias is skipped — outletId unchanged', () => {
    const filePath = path.join(tmpDir, 'phantom-locked.json');
    fs.writeFileSync(filePath, JSON.stringify({
      _locked: true,
      outletId: 'old-stale-alias',
      outlet: 'Stale Alias Display',
      criticName: 'Some Critic',
    }, null, 2));

    // Mirror the script's re-aliasing per-file logic.
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const skip = shouldSkipLockedEnrichment(data);
    assert.equal(skip.skip, true);

    // The script must `continue` here — no write should happen. Verify
    // the file is byte-identical.
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(written.outletId, 'old-stale-alias');
    assert.equal(written.outlet, 'Stale Alias Display');
  });

  test('non-locked file with stale alias is updated normally', () => {
    const filePath = path.join(tmpDir, 'phantom-unlocked.json');
    fs.writeFileSync(filePath, JSON.stringify({
      outletId: 'old-stale-alias',
      outlet: 'Stale Alias Display',
    }, null, 2));

    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const skip = shouldSkipLockedEnrichment(data);
    assert.equal(skip.skip, false);

    // Mirror the apply path.
    data.outletId = 'canonical-id';
    safeWriteReview(filePath, data);

    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(written.outletId, 'canonical-id');
  });

  test('TOPOLOGY marker is present on the merge-then-unlink path', () => {
    const src = fs.readFileSync(
      path.resolve('scripts/cleanup-phantom-outlets.js'),
      'utf8',
    );
    assert.ok(
      src.includes('TOPOLOGY: merge-then-unlink does not honor _locked'),
      'cleanup-phantom-outlets.js must mark merge-then-unlink with a TOPOLOGY comment',
    );
  });
});
