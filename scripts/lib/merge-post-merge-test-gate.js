#!/usr/bin/env node
'use strict';
//
// merge-post-merge-test-gate.js — post-merge TEST floor for merge-worktree-to-main.sh
// (task #1149).
//
// WHY THIS EXISTS
//   merge-worktree-to-main.sh already has a post-merge SYNTAX floor (`node
//   --check` on changed scripts/ files) but nothing that runs TESTS against
//   the merged tree. Syntax can't catch a semantic collision: two branches
//   can each be individually correct and pass their own pre-merge test runs,
//   yet the MERGED tree fails a colocated contract test that only exists
//   because of the OTHER branch. Reproduced 2026-08-09: a worktree branched
//   at 16:24, another session's commit (ingest-skip-classify.js + its
//   contract test) landed on origin at 16:31, local runs at 16:33-16:38 were
//   green because that test didn't exist yet at the branch point, the merge
//   script folded origin in at 16:41 and pushed, and CI went red minutes
//   later on "every skip reason review-file-writer.js emits is classified".
//   Running the full suite BEFORE the merge (what the worktree session had
//   already done) cannot catch this class — the colliding test only exists
//   WITH the merge. This module runs the colocated scripts/lib/*.test.mjs
//   suite AFTER the merge and BEFORE the push, so a real failure leaves the
//   branch intact instead of shipping it.
//
// SCOPE
//   Deliberately narrow: only scripts/lib/*.test.mjs (the same glob CI's
//   "Run scripts/lib tests" step already runs — see .github/workflows/test.yml).
//   That's the shape most susceptible to this collision (many independent
//   sessions land colocated lib helpers + contract tests concurrently) and
//   it's fast (~4min, matching CI). A broader floor (full suite, tests/unit/)
//   would slow every merge down for a class of collision this glob doesn't
//   see; widen the scope here if that class recurs outside scripts/lib/.
//
// USAGE (CLI)
//   printf '%s\n' "${CHANGED_FILES[@]}" | node scripts/lib/merge-post-merge-test-gate.js
//   Reads newline-separated changed file paths (relative to repo root) from
//   stdin, runs the gate against CWD (must be the repo root — or a directory
//   with a scripts/lib/ subdir for tests). Exit 0 = passed or not applicable.
//   Exit 1 = the merged tree fails a colocated test — DO NOT PUSH.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Pure: does this set of changed files require running the scripts/lib/
// colocated test floor? No I/O — trivially unit-testable.
function shouldRunTestGate(changedFiles) {
  return (changedFiles || []).some((f) => f.startsWith('scripts/lib/'));
}

// List the scripts/lib/*.test.mjs files present in `cwd` (same glob as CI's
// "Run scripts/lib tests" step). Returns [] if the dir doesn't exist or has
// no test files — a scripts/lib/ change with no colocated test to run yet.
function listColocatedTestFiles(cwd) {
  const dir = path.join(cwd, 'scripts', 'lib');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.test.mjs'))
    .sort()
    .map((f) => path.join('scripts', 'lib', f));
}

function defaultExec(cwd, testFiles) {
  // NODE_TEST_CONTEXT (set by node's own --test runner on itself) makes a
  // NESTED `node --test` child assume it's a subtest reporting results back
  // over an inherited IPC channel rather than a standalone run — it then
  // exits 0 regardless of failures. Caller can be this file's own
  // .test.mjs (running under `node --test` already) or, in principle, this
  // gate invoked from inside some other test-runner wrapper — strip it so
  // the child always reports its own real exit code.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ['--test', ...testFiles], {
    cwd,
    encoding: 'utf8',
    env,
  });
}

// Run the post-merge test floor. Returns { ran, passed, output, reason }.
//   ran     — whether tests were actually executed
//   passed  — true when ran is false (nothing to fail) OR the run exited 0
//   output  — captured stdout+stderr of the test run (empty if not ran)
//   reason  — human-readable note for why the gate did/didn't run
// `execFn` is injectable so tests can point at a scratch directory's fixture
// tests instead of spawning the real repo's (slow, ~4min) suite.
function runTestGate({ cwd, changedFiles, execFn = defaultExec } = {}) {
  if (!shouldRunTestGate(changedFiles)) {
    return { ran: false, passed: true, output: '', reason: 'no scripts/lib/ files changed' };
  }
  const testFiles = listColocatedTestFiles(cwd);
  if (testFiles.length === 0) {
    return { ran: false, passed: true, output: '', reason: 'no scripts/lib/*.test.mjs files found' };
  }
  const result = execFn(cwd, testFiles);
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  return {
    ran: true,
    passed: result.status === 0,
    output,
    reason: `ran ${testFiles.length} file(s): ${testFiles.join(', ')}`,
  };
}

module.exports = { shouldRunTestGate, listColocatedTestFiles, runTestGate };

if (require.main === module) {
  const input = fs.readFileSync(0, 'utf8');
  const changedFiles = input
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const { ran, passed, output, reason } = runTestGate({ cwd: process.cwd(), changedFiles });
  if (ran) {
    process.stdout.write(output);
  } else {
    console.log(`post-merge test floor: skipped (${reason})`);
  }
  if (!passed) {
    console.error(`post-merge test floor: FAILED (${reason})`);
    process.exitCode = 1;
  }
}
