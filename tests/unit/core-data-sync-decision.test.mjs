// Pins the per-file copy decision table used by push-core-data's
// "Sync core data files to checkout" step. The bash in
// .github/actions/push-core-data/action.yml mirrors this exact table via
// cmp -s; scripts/lib/core-data-sync-decision.js is the canonical tested copy.
//
// Incident 2026-07-13: the step unconditionally copied all 16 core files from
// the workflow's (start-of-run, stale) data/ dir into the fresh private-repo
// checkout, so fetch-guardian-reviews reverted a commercial.json fix pushed
// mid-run — a file that workflow never touches. The fix: only copy files the
// workflow actually modified (differs from the checkout-time snapshot).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { syncDecision } = require('../../scripts/lib/core-data-sync-decision.js');

test('unchanged file (identical to snapshot) is skipped — the incident case', () => {
  assert.equal(
    syncDecision({ workingExists: true, snapshotExists: true, identical: true }),
    'skip-unchanged',
  );
});

test('workflow-modified file (differs from snapshot) is copied', () => {
  assert.equal(
    syncDecision({ workingExists: true, snapshotExists: true, identical: false }),
    'copy-changed',
  );
});

test('new file this run (no snapshot) is copied', () => {
  // identical is meaningless without a snapshot; pass both values to prove it.
  assert.equal(
    syncDecision({ workingExists: true, snapshotExists: false, identical: false }),
    'copy-new',
  );
  assert.equal(
    syncDecision({ workingExists: true, snapshotExists: false, identical: true }),
    'copy-new',
  );
});

test('missing working file is skipped entirely — never restored from snapshot', () => {
  // The old fallback copied /tmp/core-data-snapshot/$f into the checkout when
  // data/$f was missing. That point-in-time snapshot can also revert
  // concurrent pushes, so a missing file must be a hard skip regardless of
  // snapshot state.
  assert.equal(
    syncDecision({ workingExists: false, snapshotExists: true, identical: false }),
    'skip-missing',
  );
  assert.equal(
    syncDecision({ workingExists: false, snapshotExists: true, identical: true }),
    'skip-missing',
  );
  assert.equal(
    syncDecision({ workingExists: false, snapshotExists: false, identical: false }),
    'skip-missing',
  );
});

test('decision table is exhaustive over the 8 boolean combinations', () => {
  const valid = new Set(['copy-changed', 'copy-new', 'skip-unchanged', 'skip-missing']);
  for (const workingExists of [true, false]) {
    for (const snapshotExists of [true, false]) {
      for (const identical of [true, false]) {
        const d = syncDecision({ workingExists, snapshotExists, identical });
        assert.ok(valid.has(d), `unexpected decision ${d}`);
        if (!workingExists) assert.equal(d, 'skip-missing');
      }
    }
  }
});
