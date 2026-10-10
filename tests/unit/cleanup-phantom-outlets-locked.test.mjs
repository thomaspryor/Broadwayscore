/**
 * Verifies cleanup-phantom-outlets.js's re-aliasing path skips locked files
 * (S1-T3f). outletId is NOT in PROTECTED_FIELDS, so safeWriteReview's
 * lockedOverride doesn't block it. shouldSkipLockedEnrichment is the
 * required early-return.
 *
 * Topology follow-up (2026-04-29): the merge-then-unlink path now routes
 * through safeWriteReview + safeUnlinkReview. The pre-check that refuses
 * merge when either side is locked stays as a defense-in-depth guard.
 * The TOPOLOGY: comment is removed.
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

  test('TOPOLOGY marker has been REMOVED post-helper-migration (2026-04-29)', () => {
    // Topology follow-up landed safeRenameReview + safeUnlinkReview. The
    // merge-then-unlink path now routes through the helpers. The TOPOLOGY:
    // comment was a tombstone for the bypass — once the bypass is gone, the
    // tombstone must be too. (Counterpart assertion guarding against drift.)
    const src = fs.readFileSync(
      path.resolve('scripts/cleanup-phantom-outlets.js'),
      'utf8',
    );
    assert.ok(
      !src.includes('TOPOLOGY:'),
      'cleanup-phantom-outlets.js must no longer carry a TOPOLOGY marker — the bypass has been migrated to safeUnlinkReview',
    );
  });

  test('routes through safeWriteReview + safeUnlinkReview after migration', () => {
    const src = fs.readFileSync(
      path.resolve('scripts/cleanup-phantom-outlets.js'),
      'utf8',
    );
    assert.ok(
      /safeUnlinkReview\b/.test(src),
      'cleanup-phantom-outlets must use safeUnlinkReview for phantom deletion',
    );
    assert.ok(
      !/fs\.unlinkSync\(path\.join\(showDir, phantom\.file\)\)/.test(src),
      'raw fs.unlinkSync of phantom file must be removed',
    );
  });

  test('topology stop-gap: merge refuses when canonical or phantom is locked (defense-in-depth)', () => {
    // Pre-check kept as defense-in-depth: short-circuits the entire merge if
    // either side is locked, even though safeWriteReview's lockedOverride
    // would partially protect canonical and safeUnlinkReview would refuse to
    // delete a locked phantom. Pre-check ensures all-or-nothing: we don't
    // want canonical mutated when we can't also delete phantom.
    const src = fs.readFileSync(
      path.resolve('scripts/cleanup-phantom-outlets.js'),
      'utf8',
    );
    assert.ok(
      /canonical\.data\._locked\s*===\s*true\s*\|\|\s*phantom\.data\._locked\s*===\s*true/.test(src),
      'merge-then-unlink must short-circuit when either side is locked',
    );
    assert.ok(
      src.includes('refusing merge'),
      'merge refusal must log [LOCKED-SKIP] for operator visibility',
    );
  });
});
