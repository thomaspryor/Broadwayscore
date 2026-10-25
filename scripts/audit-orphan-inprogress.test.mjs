/**
 * audit-orphan-inprogress.test.mjs — BRO-2999.
 *
 * findOrphans() used to degrade a thrown listWorkspacesFn() to `workspaces =
 * []`, and `[].some(...)` is always false — every in_progress task looked
 * orphaned during a cmux outage with no signal it ever happened. --fix could
 * then classify and apply FINISHED/STALE/LOST against that unverified
 * all-orphan result, including marking a genuinely live task's local status
 * `completed` outright (not just reclaiming it to pending). These tests cover
 * findOrphans()'s new {orphans, cmuxUnavailable} return and run()'s refusal
 * to --fix when cmuxUnavailable is set — the same fail-closed shape as the
 * BRO-2993 sibling fix in scripts/bsc-reconcile.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findOrphans, run } = require('./audit-orphan-inprogress.js');
const cmuxws = require('./lib/cmux-workspaces.js');

const inProgressTask = (id, subject = 'Some session S0: a step') => ({ id: String(id), subject, status: 'in_progress' });

test('findOrphans: a real (even empty) workspace listing behaves exactly as before', () => {
  const { orphans, cmuxUnavailable } = findOrphans({
    loadTasksFn: () => [inProgressTask(1)],
    dir: '/fake/dir',
    listWorkspacesFn: () => [],
  });
  assert.equal(cmuxUnavailable, null);
  assert.deepEqual(orphans.map((t) => t.id), ['1'], 'a genuine empty listing is real evidence of no live workspace');
});

test('findOrphans: a matching workspace is never an orphan, real listing', () => {
  const subject = 'Some session S0: a step';
  const { orphans, cmuxUnavailable } = findOrphans({
    loadTasksFn: () => [inProgressTask(1, subject)],
    dir: '/fake/dir',
    listWorkspacesFn: () => [{ ref: 'workspace:1', title: subject }],
  });
  assert.equal(cmuxUnavailable, null);
  assert.deepEqual(orphans, []);
});

test('findOrphans: a thrown listWorkspacesFn sets cmuxUnavailable instead of silently reading as zero workspaces', () => {
  const { orphans, cmuxUnavailable } = findOrphans({
    loadTasksFn: () => [inProgressTask(1), inProgressTask(2)],
    dir: '/fake/dir',
    listWorkspacesFn: () => { throw new Error('Access denied - only processes started inside cmux can connect'); },
  });
  assert.notEqual(cmuxUnavailable, null, 'a thrown listing must be classified, not silently swallowed');
  assert.equal(cmuxUnavailable, 'auth-denied');
  // Visibility for a bare report is fine — the candidate list still comes
  // back — but callers MUST check cmuxUnavailable before trusting it as
  // confirmed-orphaned (see the run() --fix test below).
  assert.deepEqual(orphans.map((t) => t.id), ['1', '2']);
});

test('findOrphans: an unrecognized thrown error still sets cmuxUnavailable (never null on throw)', () => {
  const { cmuxUnavailable } = findOrphans({
    loadTasksFn: () => [inProgressTask(1)],
    dir: '/fake/dir',
    listWorkspacesFn: () => { throw new Error('some brand new wording cmux never used before'); },
  });
  assert.notEqual(cmuxUnavailable, null);
});

// ── run(['--fix']) refusal ──────────────────────────────────────────────────

function withFixtureTasksDir(tasks, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro2999-tasks-'));
  for (const t of tasks) fs.writeFileSync(path.join(dir, `${t.id}.json`), `${JSON.stringify(t, null, 2)}\n`);
  const prevDir = process.env.CLAUDE_CODE_TASKS_DIR;
  process.env.CLAUDE_CODE_TASKS_DIR = dir;
  try { return fn(dir); }
  finally {
    if (prevDir === undefined) delete process.env.CLAUDE_CODE_TASKS_DIR;
    else process.env.CLAUDE_CODE_TASKS_DIR = prevDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function withMockedListWorkspaces(impl, fn) {
  const prev = cmuxws.listWorkspaces;
  cmuxws.listWorkspaces = impl;
  try { return fn(); }
  finally { cmuxws.listWorkspaces = prev; }
}

function withSilencedConsole(fn) {
  const prevLog = console.log;
  const prevErr = console.error;
  const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  try { return { result: fn(), lines }; }
  finally { console.log = prevLog; console.error = prevErr; }
}

test('run(["--fix"]): a cmux-unavailable listing applies ZERO status changes, even to an otherwise-eligible task', () => {
  withFixtureTasksDir([inProgressTask(42, 'Orphan candidate S0: step')], (dir) => {
    withMockedListWorkspaces(() => { throw new Error('Access denied - only processes started inside cmux can connect'); }, () => {
      const before = fs.readFileSync(path.join(dir, '42.json'), 'utf8');
      const prevExitCode = process.exitCode;
      const { result, lines } = withSilencedConsole(() => run(['--fix']));
      const exitCode = process.exitCode;
      process.exitCode = prevExitCode;

      assert.equal(result, null, 'refusal must short-circuit before classify/apply — no results object');
      assert.equal(exitCode, 2, 'a refused run must signal failure via exit code');
      const after = fs.readFileSync(path.join(dir, '42.json'), 'utf8');
      assert.equal(after, before, 'the task file must be byte-identical — cmux outage must not authorize any mutation');
      assert.ok(JSON.parse(after).status === 'in_progress', 'status must not have been flipped to completed or pending');
      assert.ok(lines.some((l) => /cmux/i.test(l) && /refus/i.test(l)), 'the refusal must be reported, not silent');
    });
  });
});

test('run(["--fix", "--dry-run"]): cmux-unavailable still refuses (dry-run does not bypass the guard)', () => {
  withFixtureTasksDir([inProgressTask(43, 'Orphan candidate S0: step')], () => {
    withMockedListWorkspaces(() => { throw new Error('Socket not found at /tmp/fake.sock'); }, () => {
      const prevExitCode = process.exitCode;
      const { result } = withSilencedConsole(() => run(['--fix', '--dry-run']));
      const exitCode = process.exitCode;
      process.exitCode = prevExitCode;
      assert.equal(result, null);
      assert.equal(exitCode, 2);
    });
  });
});

test('run(["--fix", "--json"]): refusal is machine-readable too', () => {
  withFixtureTasksDir([inProgressTask(44, 'Orphan candidate S0: step')], () => {
    withMockedListWorkspaces(() => { throw new Error('Socket not found at /tmp/fake.sock'); }, () => {
      const prevExitCode = process.exitCode;
      const { lines } = withSilencedConsole(() => run(['--fix', '--json']));
      process.exitCode = prevExitCode;
      const parsed = JSON.parse(lines.join('\n'));
      assert.ok(parsed.error);
      assert.equal(parsed.cmuxUnavailable, 'unavailable');
    });
  });
});
