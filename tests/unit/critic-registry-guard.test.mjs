/**
 * Tests for Guard G: Critic-registry misattribution detection
 * in review-file-writer.js
 *
 * Writes to a temp directory (not dryRun) so we can verify the
 * suspectedMisattribution flag is actually set in the output file.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
// Hermetic fixture registry (BRO-4550): the live data/critic-registry.json is
// rebuilt by bots, and on 2026-10-03 peter-marks gained "variety" in
// knownOutlets, silently turning the first case below red on main.
const FIXTURE_REGISTRY = {
  critics: {
    'peter-marks': { displayName: 'Peter Marks', primaryOutlet: 'washpost', knownOutlets: ['washpost'], totalReviews: 281, isFreelancer: false },
    'adam-feldman': { displayName: 'Adam Feldman', primaryOutlet: 'timeout', knownOutlets: ['timeout'], totalReviews: 500, isFreelancer: true },
  },
};

describe('Guard G: Critic-registry misattribution detection', () => {
  let createOrMergeReviewFile;
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-g-test-'));
    // The writer resolves the registry path at module load, so the env var
    // must be set BEFORE the require below.
    const registryPath = path.join(tmpDir, 'critic-registry.json');
    fs.writeFileSync(registryPath, JSON.stringify(FIXTURE_REGISTRY));
    process.env.BSC_CRITIC_REGISTRY_PATH = registryPath;
    ({ createOrMergeReviewFile } = require('../../scripts/lib/review-file-writer'));
  });

  after(() => {
    delete process.env.BSC_CRITIC_REGISTRY_PATH;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function readOutput(showId, filename) {
    const filepath = path.join(tmpDir, showId, filename);
    return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  }

  it('flags non-freelancer critic at wrong outlet', () => {
    const result = createOrMergeReviewFile('guard-g-flag', {
      outlet: 'Variety',
      outletId: 'variety',
      criticName: 'Peter Marks',
      url: 'https://variety.com/fake-review-1',
      source: 'test',
    }, { reviewTextsDir: tmpDir });

    assert.strictEqual(result.action, 'new');
    const data = readOutput('guard-g-flag', 'variety--peter-marks.json');
    assert.strictEqual(data.suspectedMisattribution, true);
    assert.ok(data.misattributionReason.includes('washpost'));
  });

  it('does NOT flag freelancer critics at any outlet', () => {
    const result = createOrMergeReviewFile('guard-g-freelancer', {
      outlet: 'New York Post',
      outletId: 'nypost',
      criticName: 'Adam Feldman',
      url: 'https://nypost.com/fake-review',
      source: 'test',
    }, { reviewTextsDir: tmpDir });

    assert.strictEqual(result.action, 'new');
    const data = readOutput('guard-g-freelancer', 'nypost--adam-feldman.json');
    assert.strictEqual(data.suspectedMisattribution, undefined);
  });

  it('does NOT flag critic at their known outlet', () => {
    const result = createOrMergeReviewFile('guard-g-correct', {
      outlet: 'Washington Post',
      outletId: 'washpost',
      criticName: 'Peter Marks',
      url: 'https://washingtonpost.com/fake-review',
      source: 'test',
    }, { reviewTextsDir: tmpDir });

    assert.strictEqual(result.action, 'new');
    const data = readOutput('guard-g-correct', 'washpost--peter-marks.json');
    assert.strictEqual(data.suspectedMisattribution, undefined);
  });

  it('does NOT flag unknown critics', () => {
    const result = createOrMergeReviewFile('guard-g-unknown', {
      outlet: 'variety',
      outletId: 'variety',
      criticName: 'Unknown',
      url: 'https://variety.com/fake-review-2',
      source: 'test',
    }, { reviewTextsDir: tmpDir });

    assert.strictEqual(result.action, 'new');
    const data = readOutput('guard-g-unknown', 'variety--unknown.json');
    assert.strictEqual(data.suspectedMisattribution, undefined);
  });

  it('does NOT flag critics not in registry', () => {
    const result = createOrMergeReviewFile('guard-g-newcritic', {
      outlet: 'variety',
      outletId: 'variety',
      criticName: 'Completely New Critic Nobody Has Heard Of',
      url: 'https://variety.com/fake-review-3',
      source: 'test',
    }, { reviewTextsDir: tmpDir });

    assert.strictEqual(result.action, 'new');
    const data = readOutput('guard-g-newcritic', 'variety--completely-new-critic-nobody-has-heard-of.json');
    assert.strictEqual(data.suspectedMisattribution, undefined);
  });

  it('does NOT flag when outletId is null', () => {
    // Null outletId is a data gap, not a misattribution
    const result = createOrMergeReviewFile('guard-g-nulloutlet', {
      outlet: 'Some Outlet',
      criticName: 'Peter Marks',
      url: 'https://example.com/fake-review',
      source: 'test',
    }, { reviewTextsDir: tmpDir });

    // May be skipped by domain guard or other guards, but should NOT crash
    assert.ok(['new', 'skipped'].includes(result.action));
  });

  it('does NOT re-flag on merge when manually cleared', () => {
    // Create initial file with suspectedMisattribution manually cleared
    const showDir = path.join(tmpDir, 'guard-g-merge');
    fs.mkdirSync(showDir, { recursive: true });
    fs.writeFileSync(path.join(showDir, 'variety--peter-marks.json'), JSON.stringify({
      showId: 'guard-g-merge',
      outletId: 'variety',
      outlet: 'Variety',
      criticName: 'Peter Marks',
      url: 'https://variety.com/fake-review-merge',
      source: 'bww-roundup',
      sources: ['bww-roundup'],
      suspectedMisattribution: false,
      misattributionManualClear: true,
    }));

    // Re-process same file — should merge, not re-flag
    const result = createOrMergeReviewFile('guard-g-merge', {
      outlet: 'Variety',
      outletId: 'variety',
      criticName: 'Peter Marks',
      url: 'https://variety.com/fake-review-merge',
      source: 'dtli',
      fields: { dtliExcerpt: 'Great show' },
    }, { reviewTextsDir: tmpDir });

    assert.strictEqual(result.action, 'updated');
    const data = readOutput('guard-g-merge', 'variety--peter-marks.json');
    // Key assertion: must remain false, not overwritten to true
    assert.strictEqual(data.suspectedMisattribution, false);
  });
});
