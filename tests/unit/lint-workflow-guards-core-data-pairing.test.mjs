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

// POSITIVE CONTROL, and it is not optional (second-opinion warning). Test 1
// asserts an ABSENCE, so it passes vacuously if the harness silently scans the
// wrong tree — e.g. if os.tmpdir() ever sits inside a git repo, the guard's
// `cd "$(git rev-parse --show-toplevel)"` lands on that outer root, the
// .github/workflows glob stays literal, BODY is empty and the guard prints
// "all clean". Pairing the comment-only file with a sentinel that MUST be
// flagged makes that failure mode loud instead of green.
test('a core-data writer named only in a YAML comment is not flagged', () => {
  const { code, out } = runGuard({ 'comment-only.yml': COMMENT_ONLY, 'sentinel.yml': REAL_INVOKE });
  assert.match(out, /sentinel\.yml\(validate-data\.js\)/,
    'positive control: the harness must actually be scanning the fixtures');
  assert.equal(code, 1, `expected failure from the sentinel alone, got exit ${code}:\n${out}`);
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

// A LARGE workflow still gets flagged. This pins the fail-OPEN regression the
// first version of this fix shipped: it matched with `printf '%s\n' "$BODY" |
// grep -q`, and `grep -q` exits at the first hit, so printf took SIGPIPE and
// the pipeline status was 141. Under `set -uo pipefail` that made the `if`
// FALSE, so a workflow that genuinely invokes validate-data.js was reported
// clean. Measured: MATCHED at 20/40 KB, MISSED(141) at 70/100/300 KB.
//
// 200 KB is deliberately well past the ~64 KB pipe-buffer threshold, and the
// invocation is the FIRST line so grep matches immediately — the earlier the
// match, the more unwritten input is left to trigger SIGPIPE. Real workflows
// are already in this range: data-health-check.yml is 73 KB with no
// push-core-data, so it sat on the failing side.
// The padding MUST NOT be comment lines. The guard strips full-line comments
// before matching, so '# padding' x N collapses to N empty lines (~1 byte
// each) and the post-sed body never reaches the pipe buffer at all — a
// comment-padded 200KB fixture passes against the broken pipe form too, which
// is exactly the false-confidence this test exists to prevent. Pad with real
// run: lines so the body stays large AFTER stripping.
test('a LARGE workflow (200KB, past the pipe-buffer threshold) is still flagged', () => {
  const pad = '      - run: echo padding-line-to-keep-this-body-large\n';
  const big = REAL_INVOKE + pad.repeat(Math.ceil(200 * 1024 / pad.length));
  assert.ok(big.length > 64 * 1024, 'fixture must exceed the pipe buffer to be meaningful');
  const { code, out } = runGuard({ 'big.yml': big });
  assert.equal(code, 1, `a 200KB workflow that invokes validate-data.js must FAIL, got exit ${code}:\n${out.slice(0, 400)}`);
  assert.match(out, /big\.yml\(validate-data\.js\)/,
    'the gate must not fail open on large files — this is the SIGPIPE/pipefail regression');
});
