// Regression test for lint-workflow-guards.sh's core-data-pairing check.
//
// The check greps workflow YAML for the names of the three scripts that write
// core data. Because that grep was a plain text search over the whole file, a
// script merely NAMED IN A COMMENT read as an invocation. On 2026-09-15 that
// blocked every `git push` on the owner's machine for ~2h: BRO-3426 added a
// rationale comment reading "`node scripts/validate-data.js`-class commands"
// to data-health-check.yml, a workflow that never invokes validate-data.js.
// It had already cost one permanent EXEMPT entry (opening-night-stage-alert.yml).
//
// These three cases pin BOTH directions, because the obvious "fix" for a
// false-positive guard is to blind it:
//   1. a comment-only mention must NOT be flagged (the bug), and
//   2. a real `run:` invocation must STILL be flagged (the guard's whole job).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GUARD = path.join(REPO, 'scripts/lint-workflow-guards.sh');

// Runs the real guard script against a throwaway tree containing only the
// given workflow files. os.tmpdir() is outside any git repo, so the script's
// `cd "$(git rev-parse --show-toplevel || echo .)"` falls back to `.` and it
// scans OUR fixtures rather than the real .github/workflows.
function runGuard(workflows) {
  const dir = mkdtempSync(path.join(tmpdir(), 'core-data-pairing-'));
  try {
    mkdirSync(path.join(dir, '.github/workflows'), { recursive: true });
    mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    copyFileSync(GUARD, path.join(dir, 'scripts/lint-workflow-guards.sh'));
    for (const [name, body] of Object.entries(workflows)) {
      writeFileSync(path.join(dir, '.github/workflows', name), body);
    }
    try {
      const stdout = execFileSync('bash', ['scripts/lint-workflow-guards.sh', 'core-data-pairing'],
        { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { code: 0, out: stdout };
    } catch (e) {
      return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const COMMENT_ONLY = `name: comment only
on: workflow_dispatch
jobs:
  x:
    runs-on: ubuntu-latest
    steps:
      # ~30 corpus-scanning \`node scripts/validate-data.js\`-class commands
      - run: echo hi
`;

const REAL_INVOKE = `name: real invoke
on: workflow_dispatch
jobs:
  x:
    runs-on: ubuntu-latest
    steps:
      - run: node scripts/validate-data.js
`;

test('a core-data writer named only in a YAML comment is not flagged', () => {
  const { code, out } = runGuard({ 'comment-only.yml': COMMENT_ONLY });
  assert.equal(code, 0, `expected pass, got exit ${code}:\n${out}`);
  assert.doesNotMatch(out, /comment-only\.yml/,
    'a script named in a comment is not an invocation — flagging it blocks unrelated pushes');
});

test('a real run: invocation without push-core-data is still flagged', () => {
  const { code, out } = runGuard({ 'real-invoke.yml': REAL_INVOKE });
  assert.equal(code, 1, `expected the guard to FAIL, got exit ${code}:\n${out}`);
  assert.match(out, /real-invoke\.yml\(validate-data\.js\)/,
    'comment-stripping must not blind the guard to genuine invocations');
});

test('with both present, only the real invocation is named', () => {
  const { code, out } = runGuard({ 'comment-only.yml': COMMENT_ONLY, 'real-invoke.yml': REAL_INVOKE });
  assert.equal(code, 1, `expected the guard to FAIL, got exit ${code}:\n${out}`);
  assert.match(out, /real-invoke\.yml/);
  assert.doesNotMatch(out, /comment-only\.yml/);
});
