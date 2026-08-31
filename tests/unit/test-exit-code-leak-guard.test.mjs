// Guards a CI-only failure mode that cost main a red Unit Tests job while every
// affected file passed locally.
//
// THE BUG. Several test files drive a CLI's main() down its refusal paths. Those
// CLIs signal refusal with `process.exitCode = 1` (scripts/linear-next.js:774,
// 783, 793; scripts/bsc-next.js:1416, 1425, 1439, 1441) rather than by calling
// process.exit. The tests stub process.exit and restore it in a finally, but
// nothing restores process.exitCode — and it does not belong to the code under
// test, it belongs to the TEST RUNNER's own process.
//
// node --test then reports the whole FILE as failed: a file-level `not ok` with
// failureType 'testCodeFailure' and exitCode 1, and NO named failing subtest,
// while every subtest reads `ok`. That signature is deeply misleading; it looks
// like a harness problem rather than a leaked global.
//
// It reproduces only when a refusal path actually runs, which is why the same
// files passed locally and failed in CI's full 730-file batch.
//
// THE FIX, in each affected file: `afterEach(() => { process.exitCode = 0; })`.
// It clears only the leak. A genuinely failing test still fails the file
// (verified directly: a file with one failing assertion and this hook still
// exits 1).
//
// THIS TEST is the ratchet. Any test file that stubs process.exit must carry the
// reset, or it can silently reintroduce a red main.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

afterEach(() => {
  process.exitCode = 0;
});

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.git' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (entry.endsWith('.test.mjs')) out.push(full);
  }
  return out;
}

test('every test file that stubs process.exit also resets process.exitCode', () => {
  const files = [...walk(path.join(repoRoot, 'scripts')), ...walk(path.join(repoRoot, 'tests'))];
  assert.ok(files.length > 50, `expected to find the test corpus, found ${files.length} files`);

  const offenders = [];
  for (const file of files) {
    // Strip line comments and string literals before matching, so prose about
    // this bug and a reset that only appears inside a quoted string are not
    // mistaken for the real thing (review finding: the regexes were loose in
    // both directions).
    const src = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');

    // Only files that hijack process.exit are at risk: they are the ones
    // deliberately driving code that signals failure by exiting. `=` but not
    // `==`/`===`, so a comparison is not read as a stub. t.mock.method(process,
    // 'exit') is the other stub form; none exist in-repo today, but it is the
    // obvious way to reintroduce this.
    const stubsExit =
      /process\.exit\s*=[^=]/.test(src) || /mock\.method\(\s*process\s*,\s*''\s*\)/.test(src);
    if (!stubsExit) continue;

    // A reset must be in an afterEach, not buried in one test body, or it only
    // protects the test that happens to call it.
    if (/afterEach\([\s\S]{0,200}?process\.exitCode\s*=/.test(src)) continue;
    offenders.push(path.relative(repoRoot, file));
  }

  assert.deepStrictEqual(
    offenders,
    [],
    'These test files stub process.exit but never reset process.exitCode. If the code ' +
      'under test sets process.exitCode = 1 on a refusal path, node --test fails the ' +
      'whole FILE with no named failing subtest, and it will only show up in CI. Add ' +
      "`afterEach(() => { process.exitCode = 0; })` to each:\n  " +
      offenders.join('\n  ')
  );
});

test('the guard is not vacuously green, and does not fire on look-alikes', () => {
  // Proves the detection logic itself, so a refactor cannot leave this test
  // passing while it checks nothing. Cases come from the pre-ship review.
  const stubsExit = (t) =>
    /process\.exit\s*=[^=]/.test(t) || /mock\.method\(\s*process\s*,\s*''\s*\)/.test(t);
  const reset = (t) => /afterEach\([\s\S]{0,200}?process\.exitCode\s*=/.test(t);

  const bad = 'process.exit = (code) => { captured = code; };';
  assert.ok(stubsExit(bad) && !reset(bad), 'an unreset stub must be flagged');

  const good = bad + '\nafterEach(() => { process.exitCode = 0; });';
  assert.ok(stubsExit(good) && reset(good), 'a stub with an afterEach reset must be accepted');

  // A comparison is not a stub.
  assert.ok(!stubsExit('if (process.exit === orig) {}'), 'a === comparison must not be flagged');

  // A reset inside ONE test body protects only that test, so it must NOT count.
  const perTestOnly = bad + '\ntest("x", () => { process.exitCode = 0; });';
  assert.ok(!reset(perTestOnly), 'a reset in a single test body must not satisfy the guard');
});

// ── BRO-2647: the SILENT TAP DECAPITATION half of the same failure shape ─────
//
// process.exitCode = 1 (above) and a real process.exit(1) (below) produce the
// SAME unreadable CI signature: the whole file `not ok`, failureType
// 'testCodeFailure', exitCode 1, and NO named failing subtest. The first leaks a
// global; the second kills the worker mid-file before node --test can flush.
//
// scripts/bsc-next.test.mjs:1261 hit the second one in CI for days: it stubs
// eight collaborators but not process.exit, because it expects the dispatch to
// SUCCEED — and in CI the BRO-2569 phantom-path guard refused instead.
//
// tests/helpers/process-exit-guard.mjs installs a throwing process.exit for
// every test in a file, so a refusal becomes a named failing subtest. These two
// tests ratchet it in and PROVE it works, by reproducing both shapes for real.

function strippedSource(file) {
  // Same normalisation as the exitCode ratchet above: drop line comments and
  // string literals so prose about this bug is never mistaken for the real thing.
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

test('every test file that stubs process.exit also installs the unstubbed-exit guard', () => {
  const files = [...walk(path.join(repoRoot, 'scripts')), ...walk(path.join(repoRoot, 'tests'))];
  assert.ok(files.length > 50, `expected to find the test corpus, found ${files.length} files`);

  const offenders = [];
  for (const file of files) {
    const src = strippedSource(file);
    const stubsExit =
      /process\.exit\s*=[^=]/.test(src) || /mock\.method\(\s*process\s*,\s*''\s*\)/.test(src);
    if (!stubsExit) continue;
    // The call must be at top level, not inside a single test body — a hook
    // registered inside one test protects only that test.
    if (/^guardProcessExit\(\);$/m.test(src)) continue;
    offenders.push(path.relative(repoRoot, file));
  }

  assert.deepStrictEqual(
    offenders,
    [],
    'These test files drive a CLI down paths that can call process.exit, but do not install ' +
      'the guard. An unstubbed exit kills the node --test worker mid-file: the whole file fails ' +
      'with ZERO named subtests and no exception text, and it only ever shows up in CI. Add ' +
      "`import { guardProcessExit } from '<rel>/tests/helpers/process-exit-guard.mjs';` and a " +
      'top-level `guardProcessExit();` to each:\n  ' +
      offenders.join('\n  ')
  );
});

test('the guard is what fixes it: an unstubbed process.exit decapitates TAP without it, and names a failing subtest with it', () => {
  // Reproduces the real CI shape in a child node --test, both ways. Without this
  // the ratchet above could pass forever while the helper does nothing.
  const helperUrl = pathToFileURL(path.join(repoRoot, 'tests', 'helpers', 'process-exit-guard.mjs')).href;
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'process-exit-guard-proof-'));

  const body = (preamble) => `${preamble}
import { test } from 'node:test';
test('subtest that is expected to succeed but hits a refusal', () => {
  process.exit(1);
});
test('a later subtest that must still be reported', () => {});
`;

  // NODE_TEST_CONTEXT is set by the runner we are running under; inherited, the
  // child refuses with "run() is being called recursively" and emits NOTHING,
  // which would make every assertion below vacuously true. Strip it.
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;

  const runFixture = (name, preamble) => {
    const file = path.join(tmp, name);
    writeFileSync(file, body(preamble));
    const r = spawnSync(process.execPath, ['--test', file], { encoding: 'utf8', env: childEnv });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    assert.ok(
      // Reporter-agnostic: the spec reporter prints "ℹ tests N", TAP prints "# tests N".
      /(?:ℹ|#)\s*tests\s+\d/.test(out),
      `the ${name} fixture produced no TAP summary at all, so this proof would be vacuous. Got:\n${out}`
    );
    return out;
  };

  try {
    const unguarded = runFixture('unguarded.test.mjs', '');
    const guarded = runFixture(
      'guarded.test.mjs',
      `import { guardProcessExit } from '${helperUrl}';\nguardProcessExit();`
    );

    // The bug, verbatim: the file dies before either subtest is reported.
    assert.ok(
      !/subtest that is expected to succeed but hits a refusal/.test(unguarded),
      `without the guard the failing subtest must NOT be nameable — that IS the bug. Got:\n${unguarded}`
    );
    assert.ok(
      !/a later subtest that must still be reported/.test(unguarded),
      `without the guard the run must be decapitated before later subtests. Got:\n${unguarded}`
    );

    // With the guard: a named failing subtest, and the file keeps running.
    assert.ok(
      /subtest that is expected to succeed but hits a refusal/.test(guarded),
      `with the guard the failing subtest must be NAMED. Got:\n${guarded}`
    );
    assert.ok(
      /UNSTUBBED_PROCESS_EXIT|did not stub it/.test(guarded),
      `with the guard the reason must appear in the output. Got:\n${guarded}`
    );
    assert.ok(
      /a later subtest that must still be reported/.test(guarded),
      `with the guard the rest of the file must still run. Got:\n${guarded}`
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
