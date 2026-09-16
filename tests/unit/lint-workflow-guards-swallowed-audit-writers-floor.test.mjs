// Regression test for lint-workflow-guards.sh's check_swallowed_audit_writers
// (BRO-3686) — see lint-workflow-guards-ledger-coverage-floor.test.mjs's
// header for the shared background: BRO-3684 fixed the too-few-workflows
// fail-open gap in check_alert_ledger_commit only; this check had the
// identical unguarded readdirSync+filter and is now fixed via the shared
// scripts/lib/workflow-glob-guard.js helper.
//
// This check is deliberately excluded from the 'workflows' composite pending
// a ~70-violation triage (its own comment in lint-workflow-guards.sh) — that
// exclusion is about which composite CALLS check_swallowed_audit_writers, not
// about the floor guard tested here, so it's orthogonal and untouched by this
// fix. This test invokes the check standalone, same as CI's dedicated step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GUARD = path.join(REPO, 'scripts/lint-workflow-guards.sh');
const CHECKER = path.join(REPO, 'scripts/lib/swallowed-audit-writer-check.js');
const SCANNER = path.join(REPO, 'scripts/lib/scan-alert-ledger-gaps.js');
const GLOB_GUARD = path.join(REPO, 'scripts/lib/workflow-glob-guard.js');

const MIN_WORKFLOWS = 50;

const CLEAN_WORKFLOW = `name: clean
on: workflow_dispatch
jobs:
  x:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;

// No acorn/node_modules dependency here — swallowed-audit-writer-check.js is
// pure text/regex over the workflow YAML, no require-graph walk.
function runGuard({ workflowCount = MIN_WORKFLOWS } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'swallowed-audit-writers-floor-'));
  try {
    mkdirSync(path.join(dir, '.github/workflows'), { recursive: true });
    mkdirSync(path.join(dir, 'scripts/lib'), { recursive: true });
    copyFileSync(GUARD, path.join(dir, 'scripts/lint-workflow-guards.sh'));
    copyFileSync(SCANNER, path.join(dir, 'scripts/lib/scan-alert-ledger-gaps.js'));
    copyFileSync(GLOB_GUARD, path.join(dir, 'scripts/lib/workflow-glob-guard.js'));
    copyFileSync(CHECKER, path.join(dir, 'scripts/lib/swallowed-audit-writer-check.js'));
    for (let i = 0; i < workflowCount; i++) {
      writeFileSync(path.join(dir, '.github/workflows', `pad-${String(i).padStart(3, '0')}.yml`), CLEAN_WORKFLOW);
    }
    try {
      const stdout = execFileSync('bash', ['scripts/lint-workflow-guards.sh', 'swallowed-audit-writers'],
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
  assert.match(out, /No workflow step swallows/);
});

// THE gap BRO-3686 closed: a near-empty .github/workflows (wrong cwd, sparse
// checkout) let the `for` loop run zero times, `any` stayed false, and the
// check printed __CLEAN__ having scanned nothing.
test('a too-small workflow tree fails the gate instead of reporting clean', () => {
  const { code, out } = runGuard({ workflowCount: 3 });
  assert.equal(code, 1, `a too-small workflow tree must fail the gate, not pass silently, got exit ${code}:\n${out}`);
  assert.doesNotMatch(out, /No workflow step swallows/,
    'a near-empty workflow tree must never be reported as a clean scan');
  assert.match(out, /too few|only 3 workflow/i);
});
