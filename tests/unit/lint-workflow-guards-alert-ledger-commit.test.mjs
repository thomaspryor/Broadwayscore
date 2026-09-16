// Regression test for lint-workflow-guards.sh's alert-ledger-commit check
// (BRO-3684).
//
// The check used to shell a `node -e` one-liner per workflow file and treat
// empty stdout as "no violations". Under this script's `set -uo pipefail` (no
// `-e`), a THROWN exception inside that one-liner — e.g.
// scripts/lib/alert-ledger-commit-check.js renamed or syntax-broken — also
// produced empty stdout, so the guard read a broken checker as CLEAN and CI
// went green having checked nothing (fails OPEN).
//
// The fix delegates to scripts/lib/scan-alert-ledger-gaps.js (BRO-3662),
// whose 0/1/2 exit contract is unit-tested in isolation
// (scan-alert-ledger-gaps.test.mjs) but — before this card — had ZERO
// production callers, so that hardening protected nothing. These tests
// exercise the actual subprocess wiring end to end: real clean tree, real
// violation, and (the load-bearing one) a broken checker, which must now FAIL
// the gate instead of silently passing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GUARD = path.join(REPO, 'scripts/lint-workflow-guards.sh');
const SCANNER = path.join(REPO, 'scripts/lib/scan-alert-ledger-gaps.js');
const CHECKER = path.join(REPO, 'scripts/lib/alert-ledger-commit-check.js');

// scan-alert-ledger-gaps.js refuses to render a verdict under 50 workflow
// files (MIN_EXPECTED_WORKFLOWS) — pad every fixture tree past that floor with
// harmless no-op workflows so the real case under test isn't itself the thing
// that trips code 2.
const MIN_WORKFLOWS = 50;

const CLEAN_WORKFLOW = `name: clean
on: workflow_dispatch
jobs:
  x:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;

const VIOLATION_WORKFLOW = `name: violation
on: workflow_dispatch
jobs:
  alert-job:
    runs-on: ubuntu-latest
    steps:
      - run: node -e "require('./scripts/lib/owner-alert-router.js').routeAlert({})"
`;

// Runs the real guard script (with the real scanner + checker it now shells
// out to) against a throwaway tree. os.tmpdir() is outside any git repo, so
// the script's `cd "$(git rev-parse --show-toplevel || echo .)"` falls back to
// `.` and it scans OUR fixtures rather than the real .github/workflows.
// checkerOverride optionally replaces the copied alert-ledger-commit-check.js
// contents, to simulate it being broken.
function runGuard(extraWorkflows, { checkerOverride } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'alert-ledger-commit-'));
  try {
    mkdirSync(path.join(dir, '.github/workflows'), { recursive: true });
    mkdirSync(path.join(dir, 'scripts/lib'), { recursive: true });
    copyFileSync(GUARD, path.join(dir, 'scripts/lint-workflow-guards.sh'));
    copyFileSync(SCANNER, path.join(dir, 'scripts/lib/scan-alert-ledger-gaps.js'));
    if (checkerOverride !== undefined) {
      writeFileSync(path.join(dir, 'scripts/lib/alert-ledger-commit-check.js'), checkerOverride);
    } else {
      copyFileSync(CHECKER, path.join(dir, 'scripts/lib/alert-ledger-commit-check.js'));
    }
    for (const [name, body] of Object.entries(extraWorkflows)) {
      writeFileSync(path.join(dir, '.github/workflows', name), body);
    }
    const padNeeded = Math.max(0, MIN_WORKFLOWS - Object.keys(extraWorkflows).length);
    for (let i = 0; i < padNeeded; i++) {
      writeFileSync(path.join(dir, '.github/workflows', `pad-${String(i).padStart(3, '0')}.yml`), CLEAN_WORKFLOW);
    }
    try {
      const stdout = execFileSync('bash', ['scripts/lint-workflow-guards.sh', 'alert-ledger-commit'],
        { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { code: 0, out: stdout };
    } catch (e) {
      return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a clean tree (past the workflow-count floor) passes', () => {
  const { code, out } = runGuard({});
  assert.equal(code, 0, `expected a clean tree to pass, got exit ${code}:\n${out}`);
  assert.match(out, /All routeAlert\(\)\/resolveCondition\(\) callers commit/);
});

test('a real routeAlert() caller with no ledger commit step is flagged', () => {
  const { code, out } = runGuard({ 'violation.yml': VIOLATION_WORKFLOW });
  assert.equal(code, 1, `expected the guard to FAIL on a real violation, got exit ${code}:\n${out}`);
  assert.match(out, /violation\.yml/);
  assert.match(out, /alert-ledger\.json/);
});

// THE regression this card exists to fix. Before BRO-3684, a broken checker
// produced empty stdout from the old per-file `node -e`, `set -uo pipefail`
// (no `-e`) let the throw pass silently, and `[ -n "$out" ]` read "empty" as
// "no violations" — the gate printed CLEAN with FAILED still 0. It must now
// FAIL instead, even though the workflow tree itself has zero real violations.
test('a broken checker fails the gate instead of reporting clean (fails CLOSED)', () => {
  const brokenChecker = "'use strict';\nthrow new Error('simulated broken checker — BRO-3684 regression guard');\nmodule.exports = {};\n";
  const { code, out } = runGuard({}, { checkerOverride: brokenChecker });
  assert.equal(code, 1, `a broken checker must fail the gate, not pass silently, got exit ${code}:\n${out}`);
  assert.doesNotMatch(out, /All routeAlert\(\)\/resolveCondition\(\) callers commit/,
    'a broken checker must never be reported as a clean scan');
  assert.match(out, /could not (run|load)/i);
});

// A checker that returns a non-array (e.g. a future refactor accidentally
// returns undefined for a no-jobs workflow) is the OTHER concrete way this
// class of bug recurred (see scan-alert-ledger-gaps.js's own header comment on
// the "checker returned a string" incident). Must also fail closed, not pass.
test('a checker returning a non-array fails the gate instead of reporting clean', () => {
  const badChecker = "'use strict';\nmodule.exports = { findMissingLedgerCommits: () => undefined };\n";
  const { code, out } = runGuard({}, { checkerOverride: badChecker });
  assert.equal(code, 1, `a non-array-returning checker must fail the gate, got exit ${code}:\n${out}`);
  assert.doesNotMatch(out, /All routeAlert\(\)\/resolveCondition\(\) callers commit/);
});
