// Regression test for scan-alert-ledger-gaps.js's CLI (require.main block),
// which is NOT exercised by scan-alert-ledger-gaps.test.mjs (that file drives
// scanWorkflows() directly, injecting its own checker function).
//
// BRO-3686 changed the CLI to pass a real routerCallerScripts Set into
// findMissingLedgerCommits() (parity with lint-workflow-guards.sh's
// check_alert_ledger_commit) via findRouterCallerScripts(), which walks
// scripts/**/*.js with a plain fs.readdirSync (require-graph-ast.js's
// findTrackedCallerScripts) and can throw. Uncaught, that would exit this
// CLI with node's default code 1 — the same code this file's own contract
// uses for "scanned a real tree, violations found" — turning a setup failure
// into a false "violations found" verdict. This test pins the fix: a
// throwing findRouterCallerScripts() must exit 2, and a healthy run must
// still exit 0 on a clean tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, symlinkSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCANNER = path.join(REPO, 'scripts/lib/scan-alert-ledger-gaps.js');
const CHECKER = path.join(REPO, 'scripts/lib/alert-ledger-commit-check.js');
const REQUIRE_GRAPH = path.join(REPO, 'scripts/lib/require-graph-ast.js');

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

function runCli({ checkerOverride } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'scan-gaps-cli-'));
  try {
    mkdirSync(path.join(dir, '.github/workflows'), { recursive: true });
    mkdirSync(path.join(dir, 'scripts/lib'), { recursive: true });
    symlinkSync(NODE_MODULES, path.join(dir, 'node_modules'));
    copyFileSync(SCANNER, path.join(dir, 'scripts/lib/scan-alert-ledger-gaps.js'));
    copyFileSync(REQUIRE_GRAPH, path.join(dir, 'scripts/lib/require-graph-ast.js'));
    if (checkerOverride !== undefined) {
      writeFileSync(path.join(dir, 'scripts/lib/alert-ledger-commit-check.js'), checkerOverride);
    } else {
      copyFileSync(CHECKER, path.join(dir, 'scripts/lib/alert-ledger-commit-check.js'));
    }
    for (let i = 0; i < MIN_WORKFLOWS; i++) {
      writeFileSync(path.join(dir, '.github/workflows', `pad-${String(i).padStart(3, '0')}.yml`), CLEAN_WORKFLOW);
    }
    try {
      const stdout = execFileSync('node', ['scripts/lib/scan-alert-ledger-gaps.js'],
        { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { code: 0, out: stdout };
    } catch (e) {
      return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a clean tree exits 0 with the real router-caller-scripts resolution wired in', () => {
  const { code, out } = runCli({});
  assert.equal(code, 0, `expected exit 0, got ${code}:\n${out}`);
  assert.match(out, /TOTAL VIOLATIONS: 0/);
});

// THE bug: findRouterCallerScripts() throwing must not collapse into exit 1
// ("violations found") — it must report exit 2 ("could not scan").
test('findRouterCallerScripts() throwing exits 2, not 1 (does not read as "violations found")', () => {
  const throwingChecker = [
    "'use strict';",
    "function findMissingLedgerCommits() { return []; }",
    "function findRouterCallerScripts() { throw new Error('simulated require-graph failure'); }",
    "module.exports = { findMissingLedgerCommits, findRouterCallerScripts };",
  ].join('\n');
  const { code, out } = runCli({ checkerOverride: throwingChecker });
  assert.equal(code, 2, `a thrown findRouterCallerScripts() must exit 2 (could not scan), got ${code}:\n${out}`);
  assert.doesNotMatch(out, /TOTAL VIOLATIONS/, 'a setup failure must never print a violations verdict');
  assert.match(out, /simulated require-graph failure/);
});
