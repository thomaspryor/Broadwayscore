// Regression test for lint-workflow-guards.sh's check_ledger_coverage
// (BRO-3686).
//
// BRO-3684 fixed the too-few-workflows fail-open gap (a wrong-cwd or
// near-empty .github/workflows silently reporting __CLEAN__ having scanned
// nothing) in ONE function, check_alert_ledger_commit. This check reused the
// identical unguarded `fs.readdirSync(dir).filter(f => f.endsWith('.yml'))`
// pattern and did not get the fix. It now shares
// scripts/lib/workflow-glob-guard.js's readWorkflowFilesOrFailClosed() with
// check_alert_ledger_commit, check_ledger_step_guard and
// check_swallowed_audit_writers — this test pins the fail-closed behavior for
// THIS check the same way lint-workflow-guards-alert-ledger-commit.test.mjs
// pins it for that one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, symlinkSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GUARD = path.join(REPO, 'scripts/lint-workflow-guards.sh');
const CHECKER = path.join(REPO, 'scripts/lib/ledger-coverage-check.js');
const REQUIRE_GRAPH = path.join(REPO, 'scripts/lib/require-graph-ast.js');
const SCANNER = path.join(REPO, 'scripts/lib/scan-alert-ledger-gaps.js');
const GLOB_GUARD = path.join(REPO, 'scripts/lib/workflow-glob-guard.js');

// Mirrors lint-workflow-guards-alert-ledger-commit.test.mjs's rationale: a
// worktree checkout has no node_modules of its own, so walk up from REPO the
// way Node's module resolution does to find the real one (acorn lives there).
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

const MIN_WORKFLOWS = 50;

const CLEAN_WORKFLOW = `name: clean
on: workflow_dispatch
jobs:
  x:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;

// A fixture-local exemptions file with an empty list — the real
// ledger-coverage-exemptions.js's one entry names a specific
// (update-show-status.yml, create-issue) pair that won't exist in this
// throwaway tree, which would otherwise make every run report a "STALE
// EXEMPTION" finding unrelated to what this test is pinning.
const EMPTY_EXEMPTIONS = "module.exports = { EXEMPTIONS: [], isExempt: () => false };\n";

function runGuard({ workflowCount = MIN_WORKFLOWS } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ledger-coverage-floor-'));
  try {
    mkdirSync(path.join(dir, '.github/workflows'), { recursive: true });
    mkdirSync(path.join(dir, 'scripts/lib'), { recursive: true });
    symlinkSync(NODE_MODULES, path.join(dir, 'node_modules'));
    copyFileSync(GUARD, path.join(dir, 'scripts/lint-workflow-guards.sh'));
    copyFileSync(REQUIRE_GRAPH, path.join(dir, 'scripts/lib/require-graph-ast.js'));
    copyFileSync(SCANNER, path.join(dir, 'scripts/lib/scan-alert-ledger-gaps.js'));
    copyFileSync(GLOB_GUARD, path.join(dir, 'scripts/lib/workflow-glob-guard.js'));
    copyFileSync(CHECKER, path.join(dir, 'scripts/lib/ledger-coverage-check.js'));
    writeFileSync(path.join(dir, 'scripts/lib/ledger-coverage-exemptions.js'), EMPTY_EXEMPTIONS);
    for (let i = 0; i < workflowCount; i++) {
      writeFileSync(path.join(dir, '.github/workflows', `pad-${String(i).padStart(3, '0')}.yml`), CLEAN_WORKFLOW);
    }
    try {
      const stdout = execFileSync('bash', ['scripts/lint-workflow-guards.sh', 'ledger-coverage'],
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
  assert.match(out, /All ledger-reaching/);
});

// THE gap BRO-3686 closed: a near-empty .github/workflows (wrong cwd, sparse
// checkout) let the `for` loop run zero times, `any` stayed false, and the
// check printed __CLEAN__ having scanned nothing.
test('a too-small workflow tree fails the gate instead of reporting clean', () => {
  const { code, out } = runGuard({ workflowCount: 3 });
  assert.equal(code, 1, `a too-small workflow tree must fail the gate, not pass silently, got exit ${code}:\n${out}`);
  assert.doesNotMatch(out, /All ledger-reaching/,
    'a near-empty workflow tree must never be reported as a clean scan');
  assert.match(out, /too few|only 3 workflow/i);
});
