// Regression test for lint-workflow-guards.sh's alert-ledger-commit check
// (BRO-3684).
//
// The check used to shell a `node -e` one-liner per workflow file and treat
// empty stdout as "no violations" — under this script's `set -uo pipefail`
// (no `-e`), a THROWN exception inside that one-liner also produced empty
// stdout, so a broken checker read as CLEAN and CI went green having checked
// nothing (fails OPEN).
//
// BRO-3671 (landed separately, same day) rewrote the check to resolve the
// routeAlert()/resolveCondition() require-graph and switched to exact-string
// sentinel matching (`[ "$OUT" = "__CLEAN__" ]`), which incidentally already
// fails CLOSED on a throw: anything other than a literal "__CLEAN__" or
// "__ACORN_MISSING__" falls into the violation-reporting branch and sets
// FAILED=1. What BRO-3671 did NOT add is a floor on the workflow-file count —
// an empty or near-empty `.github/workflows` (wrong cwd, sparse checkout)
// still let the `for` loop run zero times and print `__CLEAN__` having
// scanned nothing, the exact failure shape this card is about. This test
// pins all three fail-closed paths: real violation, broken checker, and a
// too-small workflow tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, symlinkSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GUARD = path.join(REPO, 'scripts/lint-workflow-guards.sh');
const CHECKER = path.join(REPO, 'scripts/lib/alert-ledger-commit-check.js');
const REQUIRE_GRAPH = path.join(REPO, 'scripts/lib/require-graph-ast.js');
const SCANNER = path.join(REPO, 'scripts/lib/scan-alert-ledger-gaps.js');

// A worktree checkout has no node_modules of its own — `require('acorn')`
// resolves there today only because Node's module lookup walks up parent
// directories until it finds one (landing on the main repo checkout two
// levels up). Symlinking `path.join(REPO, 'node_modules')` would point at a
// path that doesn't exist in a worktree, so walk up from REPO the same way
// Node does to find the real one.
function findNodeModules(startDir) {
  let dir = startDir;
  while (true) {
    const candidate = path.join(dir, 'node_modules');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`no node_modules found walking up from ${startDir}`);
    dir = parent;
  }
}
const NODE_MODULES = findNodeModules(REPO);

// Matches scan-alert-ledger-gaps.js's MIN_EXPECTED_WORKFLOWS, which this
// check now reuses as its own floor rather than a second hardcoded number.
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

// Runs the real guard script (with the real require-graph checker it depends
// on) against a throwaway tree. os.tmpdir() is outside any git repo, so the
// script's `cd "$(git rev-parse --show-toplevel || echo .)"` falls back to
// `.` and it scans OUR fixtures rather than the real .github/workflows.
// checkerOverride optionally replaces the copied alert-ledger-commit-check.js
// contents, to simulate it being broken. node_modules is symlinked in (not
// copied) so require('acorn') resolves — the checker's require-graph walk
// depends on it.
function runGuard(extraWorkflows, { checkerOverride, workflowCount = MIN_WORKFLOWS } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'alert-ledger-commit-'));
  try {
    mkdirSync(path.join(dir, '.github/workflows'), { recursive: true });
    mkdirSync(path.join(dir, 'scripts/lib'), { recursive: true });
    symlinkSync(NODE_MODULES, path.join(dir, 'node_modules'));
    copyFileSync(GUARD, path.join(dir, 'scripts/lint-workflow-guards.sh'));
    copyFileSync(REQUIRE_GRAPH, path.join(dir, 'scripts/lib/require-graph-ast.js'));
    copyFileSync(SCANNER, path.join(dir, 'scripts/lib/scan-alert-ledger-gaps.js'));
    if (checkerOverride !== undefined) {
      writeFileSync(path.join(dir, 'scripts/lib/alert-ledger-commit-check.js'), checkerOverride);
    } else {
      copyFileSync(CHECKER, path.join(dir, 'scripts/lib/alert-ledger-commit-check.js'));
    }
    for (const [name, body] of Object.entries(extraWorkflows)) {
      writeFileSync(path.join(dir, '.github/workflows', name), body);
    }
    const padNeeded = Math.max(0, workflowCount - Object.keys(extraWorkflows).length);
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

// A residual regression check: BRO-3671's exact-sentinel-match rewrite
// happens to already fail closed on a throw (neither "__CLEAN__" nor
// "__ACORN_MISSING__" matches empty/partial output from a crash, so it falls
// into the violation-reporting branch). This pins that it STAYS fail-closed
// across future edits to this function, even though it's no longer the
// specific mechanism BRO-3684 introduced.
test('a broken checker fails the gate instead of reporting clean (fails CLOSED)', () => {
  const brokenChecker = "'use strict';\nthrow new Error('simulated broken checker — BRO-3684 regression guard');\nmodule.exports = {};\n";
  const { code, out } = runGuard({}, { checkerOverride: brokenChecker });
  assert.equal(code, 1, `a broken checker must fail the gate, not pass silently, got exit ${code}:\n${out}`);
  assert.doesNotMatch(out, /All routeAlert\(\)\/resolveCondition\(\) callers commit/,
    'a broken checker must never be reported as a clean scan');
});

// THE gap BRO-3684 found that BRO-3671's rewrite did NOT close: a near-empty
// .github/workflows (wrong cwd, sparse checkout) let the `for` loop run zero
// times, `any` stayed false, and the check printed __CLEAN__ having scanned
// nothing. Must now fail instead.
test('a too-small workflow tree fails the gate instead of reporting clean', () => {
  const { code, out } = runGuard({}, { workflowCount: 3 });
  assert.equal(code, 1, `a too-small workflow tree must fail the gate, not pass silently, got exit ${code}:\n${out}`);
  assert.doesNotMatch(out, /All routeAlert\(\)\/resolveCondition\(\) callers commit/,
    'a near-empty workflow tree must never be reported as a clean scan');
  assert.match(out, /too few|only 3 workflow/i);
});
