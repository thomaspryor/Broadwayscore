// TESTS-VS-DERIVED-DATA-EXEMPT: fixture files named awards.json/outlet-registry.json
// are written under mkdtempSync() temp dirs — this never reads the real data/*.json.
// Pins computeExclusions() from scripts/lib/core-data-public-stage-exclusions.js
// — the fix for task #989 (outlet-registry lost-update). checkout-core-data
// overwrites data/outlet-registry.json (and 2 other stray-tracked core files)
// from the private repo's checkout-time snapshot regardless of whether the
// running workflow touches them; stage-data-changes.sh's blind `git add data/`
// then committed that copy even when it reverted a public-repo-only fix. This
// reuses push-core-data's snapshot-identity check in the opposite direction:
// a file identical to its checkout-time snapshot was NOT touched by this run
// and must be excluded from the public commit too.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { computeExclusions, DUAL_TRACKED_FILES } = require('../../scripts/lib/core-data-public-stage-exclusions.js');

function withDirs(fn) {
  const root = mkdtempSync(join(tmpdir(), 'core-data-exclusions-'));
  const dataDir = join(root, 'data');
  const snapshotDir = join(root, 'snapshot');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(snapshotDir, { recursive: true });
  try {
    return fn({ dataDir, snapshotDir });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('no snapshot dir (no checkout-core-data this run) fails open — nothing excluded', () => {
  const root = mkdtempSync(join(tmpdir(), 'core-data-exclusions-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  try {
    const result = computeExclusions({ dataDir, snapshotDir: join(root, 'does-not-exist') });
    assert.deepEqual(result, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unchanged file (identical to snapshot) is excluded — the incident case', () => {
  withDirs(({ dataDir, snapshotDir }) => {
    const content = JSON.stringify({ outlets: { foo: { multiAuthor: true } } });
    writeFileSync(join(dataDir, 'outlet-registry.json'), content);
    writeFileSync(join(snapshotDir, 'outlet-registry.json'), content);

    const result = computeExclusions({ dataDir, snapshotDir });
    assert.ok(result.includes(`${dataDir}/outlet-registry.json`));
  });
});

test('workflow-modified file (differs from snapshot) is NOT excluded — stages normally', () => {
  withDirs(({ dataDir, snapshotDir }) => {
    writeFileSync(join(dataDir, 'outlet-registry.json'), JSON.stringify({ outlets: { foo: { multiAuthor: true } } }));
    writeFileSync(join(snapshotDir, 'outlet-registry.json'), JSON.stringify({ outlets: { foo: {} } }));

    const result = computeExclusions({ dataDir, snapshotDir });
    assert.ok(!result.includes(`${dataDir}/outlet-registry.json`));
  });
});

test('new file this run (no snapshot entry) is NOT excluded', () => {
  withDirs(({ dataDir, snapshotDir }) => {
    writeFileSync(join(dataDir, 'awards.json'), JSON.stringify({ shows: {} }));
    // no snapshot file written for awards.json

    const result = computeExclusions({ dataDir, snapshotDir });
    assert.ok(!result.includes(`${dataDir}/awards.json`));
  });
});

test('missing working file is NOT excluded (git add naturally no-ops on it)', () => {
  withDirs(({ dataDir, snapshotDir }) => {
    writeFileSync(join(snapshotDir, 'awards.json'), JSON.stringify({ shows: {} }));
    // data/awards.json never written

    const result = computeExclusions({ dataDir, snapshotDir });
    assert.ok(!result.includes(`${dataDir}/awards.json`));
  });
});

test('covers all three known dual-tracked files, and only those', () => {
  assert.deepEqual(
    [...DUAL_TRACKED_FILES].sort(),
    ['audience-reviews-lbo.json', 'awards.json', 'outlet-registry.json'].sort(),
  );

  withDirs(({ dataDir, snapshotDir }) => {
    for (const f of DUAL_TRACKED_FILES) {
      const content = JSON.stringify({ f });
      writeFileSync(join(dataDir, f), content);
      writeFileSync(join(snapshotDir, f), content);
    }
    const result = computeExclusions({ dataDir, snapshotDir });
    assert.equal(result.length, DUAL_TRACKED_FILES.length);
  });
});
