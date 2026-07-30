// Task #649 — Discovery + IBDB date writes discarded by UNRELATED pre-existing
// validation errors. Locks the set-diff decision logic in
// scripts/lib/validation-setdiff.js that both update-show-status.yml's
// discovery gate and enrich-ibdb-dates.js's post-enrichment gate depend on:
// a run should still commit when it introduces no NEW validation error, even
// if pre-existing (unrelated) errors remain.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseErrorLines,
  computeNewErrors,
  shouldCommitDespiteValidationErrors,
  evaluateCommitDecision,
} from '../../scripts/lib/validation-setdiff.js';

describe('parseErrorLines', () => {
  test('extracts ❌ ERROR: lines, ignores ✅/⚠️/ℹ️ noise', () => {
    const text = [
      'ℹ️  Checking shows...',
      '✅ No duplicate shows found',
      '❌ ERROR: Shared ibdbUrl https://ibdb.com/x on 2 shows',
      '⚠️  WARNING: some warning',
      '❌ ERROR: lottery-rush.json has an orphaned show ID',
    ].join('\n');
    assert.deepEqual(parseErrorLines(text), [
      'Shared ibdbUrl https://ibdb.com/x on 2 shows',
      'lottery-rush.json has an orphaned show ID',
    ]);
  });

  test('trims whitespace and handles empty/undefined input', () => {
    assert.deepEqual(parseErrorLines(''), []);
    assert.deepEqual(parseErrorLines(undefined), []);
    assert.deepEqual(parseErrorLines('  ❌ ERROR:   spaced out msg   \n'), ['spaced out msg']);
  });

  test('does not match a line that merely contains the marker mid-sentence', () => {
    // console.log(`\n❌ FAILED: ${errors.length} error(s) found\n`) style summary
    // lines must not be double-counted as individual errors.
    const text = '❌ FAILED: 2 error(s) found\n   1. Shared ibdbUrl on show X\n   2. Missing venue on show Y';
    assert.deepEqual(parseErrorLines(text), []);
  });
});

describe('computeNewErrors', () => {
  test('empty when post is a subset of pre (only pre-existing errors remain)', () => {
    const pre = ['lottery-rush.json orphan: xyz'];
    const post = ['lottery-rush.json orphan: xyz'];
    assert.deepEqual(computeNewErrors(pre, post), []);
  });

  test('returns errors present in post but absent from pre', () => {
    const pre = ['lottery-rush.json orphan: xyz'];
    const post = ['lottery-rush.json orphan: xyz', 'Shared ibdbUrl on show new-show-2026'];
    assert.deepEqual(computeNewErrors(pre, post), ['Shared ibdbUrl on show new-show-2026']);
  });

  test('pre-existing error disappearing is not a "new" error', () => {
    const pre = ['lottery-rush.json orphan: xyz', 'commercial.json bad field'];
    const post = ['lottery-rush.json orphan: xyz'];
    assert.deepEqual(computeNewErrors(pre, post), []);
  });

  test('both empty → no new errors', () => {
    assert.deepEqual(computeNewErrors([], []), []);
  });
});

describe('shouldCommitDespiteValidationErrors', () => {
  test('true when post errors are a subset of pre errors (pre-existing only)', () => {
    const pre = ['peripheral file X is broken'];
    const post = ['peripheral file X is broken'];
    assert.equal(shouldCommitDespiteValidationErrors(pre, post), true);
  });

  test('true when both clean', () => {
    assert.equal(shouldCommitDespiteValidationErrors([], []), true);
  });

  test('false when this run introduces any new error, even alongside pre-existing ones', () => {
    const pre = ['peripheral file X is broken'];
    const post = ['peripheral file X is broken', 'Discovered show missing required field: venue'];
    assert.equal(shouldCommitDespiteValidationErrors(pre, post), false);
  });

  test('false when a fresh error appears with no pre-existing baseline', () => {
    assert.equal(shouldCommitDespiteValidationErrors([], ['Discovered show missing required field: venue']), false);
  });

  // Card #649's suggested-approach note: gating merely on
  // pre-validation-status=='broken' would weaken the guard that stops
  // discovery writing garbage. Assert the set-diff — not "was anything ever
  // broken" — is what decides.
  test('gating on set-diff, not on whether pre had ANY errors at all', () => {
    const pre = ['error A', 'error B', 'error C'];
    const post = ['error A', 'error B', 'error C'];
    assert.equal(shouldCommitDespiteValidationErrors(pre, post), true,
      'three pre-existing errors alone must not block a run that introduced zero new ones');
  });
});

// ship-check finding (2026-07-30): a validate-data.js crash or output-format
// change can exit non-zero while printing nothing that matches "❌ ERROR:"
// (its uncaughtException handler dumps a raw Error, not the error() line
// format) — pure text-diffing alone reads that as "0 new errors" and wrongly
// commits. evaluateCommitDecision's postExitCode check closes that gap.
describe('evaluateCommitDecision', () => {
  test('clean pre-existing-only case still commits (matches shouldCommitDespiteValidationErrors)', () => {
    const preErrors = ['peripheral file X is broken'];
    const postErrors = ['peripheral file X is broken'];
    const result = evaluateCommitDecision({ preErrors, postErrors, postExitCode: 1 });
    assert.equal(result.shouldCommit, true);
    assert.deepEqual(result.newErrors, []);
  });

  test('new error still blocks even with postExitCode provided', () => {
    const preErrors = [];
    const postErrors = ['Discovered show missing required field: venue'];
    const result = evaluateCommitDecision({ preErrors, postErrors, postExitCode: 1 });
    assert.equal(result.shouldCommit, false);
    assert.deepEqual(result.newErrors, postErrors);
  });

  test('clean exit code 0 always commits regardless of stale parsed text', () => {
    const result = evaluateCommitDecision({ preErrors: [], postErrors: [], postExitCode: 0 });
    assert.equal(result.shouldCommit, true);
  });

  test('crash safety net: non-zero exit + zero parsed errors blocks the commit', () => {
    const preErrors = [];
    const postErrors = []; // e.g. an uncaught exception dumped a raw stack, no "❌ ERROR:" lines
    const result = evaluateCommitDecision({ preErrors, postErrors, postExitCode: 1 });
    assert.equal(result.shouldCommit, false,
      'a non-zero exit with no parseable error lines must not silently pass as "0 new errors"');
    assert.match(result.reason, /crash|format change/i);
  });

  test('crash safety net still fires even when pre-run also had zero parsed errors', () => {
    // Confirms the check is keyed off postExitCode + postErrors, not off any
    // asymmetry with the baseline — a baseline that was ALSO unparseable must
    // not make this look like "no change".
    const result = evaluateCommitDecision({ preErrors: [], postErrors: [], postExitCode: 1 });
    assert.equal(result.shouldCommit, false);
  });

  test('without postExitCode (legacy callers), falls back to pure set-diff', () => {
    const preErrors = ['peripheral file X is broken'];
    const postErrors = ['peripheral file X is broken'];
    const result = evaluateCommitDecision({ preErrors, postErrors });
    assert.equal(result.shouldCommit, true);
  });
});
