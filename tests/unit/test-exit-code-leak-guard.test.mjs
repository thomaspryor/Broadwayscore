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
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
