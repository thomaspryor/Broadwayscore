/**
 * BRO-1322: "~75% of test.yml runs on main cancel before validating
 * (data-commit churn)". Filed 2026-06-06 against the shared-group +
 * cancel-in-progress:true concurrency shape; the fix (per-commit concurrency
 * group on main, keyed by github.sha) landed 2026-07-12 under task #1581 and
 * is pinned by tests/unit/ci-cancellation-logic.test.mjs, which this file
 * requires rather than re-implementing (CLAUDE.md #15: require the real
 * function, never copy logic).
 *
 * This file exists at the exact path BRO-1322's acceptance criteria named
 * (`node --test tests/unit/ci-health-test-yml-cancellation.test.mjs`) so that
 * command keeps working for anyone re-verifying this card, without
 * duplicating the decision logic itself.
 *
 * Live confirmation (2026-09-15, last 100 main test.yml runs via
 * `gh run list --workflow=test.yml --branch=main --limit=100`): 2 cancelled
 * out of 100 (2%, down from the reported ~75%), and both of those were a
 * single non-blocking job (Design Token Drift Guard) inside an otherwise-
 * completed run — not the whole-run supersession this card describes. No
 * push-triggered main run in that sample was cancelled mid-setup.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { triggersOnMainPush, readConcurrency, findConcurrencyViolation } = require(
  '../../scripts/lib/ci-cancellation-guard.js'
);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEST_YML = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'test.yml'), 'utf8');

test('acceptance: test.yml still runs on push to main', () => {
  assert.equal(triggersOnMainPush(TEST_YML), true);
});

test('acceptance: test.yml has no concurrency violation (no shared-group cancel-in-progress:true on main)', () => {
  assert.equal(findConcurrencyViolation(TEST_YML), null);
});

test('acceptance: test.yml concurrency group is per-commit on main (github.sha), so a data-only push cannot supersede an in-flight code-push run', () => {
  const c = readConcurrency(TEST_YML);
  assert.ok(c, 'test.yml should have a concurrency block');
  assert.ok(c.group.includes('github.sha'), `expected github.sha in group, got: ${c.group}`);
});
