import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { shouldRunTestGate, listColocatedTestFiles, runTestGate, diffFailingSets } = require('./merge-post-merge-test-gate.js');

// --- shouldRunTestGate: pure decision, no I/O ---

test('shouldRunTestGate: true when a scripts/lib/ file changed', () => {
  assert.equal(shouldRunTestGate(['scripts/lib/foo.js', 'src/app.tsx']), true);
});

test('shouldRunTestGate: false when nothing under scripts/lib/ changed', () => {
  assert.equal(shouldRunTestGate(['scripts/other.js', 'src/app.tsx']), false);
});

test('shouldRunTestGate: false on empty/undefined input', () => {
  assert.equal(shouldRunTestGate([]), false);
  assert.equal(shouldRunTestGate(undefined), false);
});

// --- Scratch-tree fixtures: seed a real scripts/lib/ dir with colocated
// tests so runTestGate exercises the real listColocatedTestFiles() + a real
// `node --test` spawn, not a mocked exec. This is the closest a fast unit
// test can get to "seed a deliberate contract violation on a scratch branch"
// without actually driving git — the acceptance criteria's real end-to-end
// check (a scratch branch + merge-worktree-to-main.sh) was run separately by
// hand; see the card. ---

function makeScratchRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-test-gate-'));
  fs.mkdirSync(path.join(dir, 'scripts', 'lib'), { recursive: true });
  return dir;
}

function writePassingTest(dir, name = 'contract.test.mjs') {
  fs.writeFileSync(
    path.join(dir, 'scripts', 'lib', name),
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('passes', () => { assert.equal(1, 1); });\n"
  );
}

function writeFailingTest(dir, name = 'contract.test.mjs') {
  fs.writeFileSync(
    path.join(dir, 'scripts', 'lib', name),
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('every skip reason is classified', () => { assert.equal(1, 2, 'semantic collision: unclassified skip reason'); });\n"
  );
}

// --- listColocatedTestFiles ---

test('listColocatedTestFiles: finds *.test.mjs under scripts/lib/', () => {
  const dir = makeScratchRepo();
  writePassingTest(dir, 'a.test.mjs');
  writePassingTest(dir, 'b.test.mjs');
  fs.writeFileSync(path.join(dir, 'scripts', 'lib', 'not-a-test.js'), 'module.exports = {};\n');
  const found = listColocatedTestFiles(dir);
  assert.deepEqual(found.sort(), [path.join('scripts', 'lib', 'a.test.mjs'), path.join('scripts', 'lib', 'b.test.mjs')]);
});

test('listColocatedTestFiles: empty array when scripts/lib/ has no test files', () => {
  const dir = makeScratchRepo();
  assert.deepEqual(listColocatedTestFiles(dir), []);
});

test('listColocatedTestFiles: empty array when scripts/lib/ does not exist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-test-gate-empty-'));
  assert.deepEqual(listColocatedTestFiles(dir), []);
});

// --- runTestGate: the two acceptance-criteria scenarios ---

test('runTestGate: a merged tree whose colocated test FAILS causes the gate to refuse', () => {
  const dir = makeScratchRepo();
  writeFailingTest(dir);
  const result = runTestGate({ cwd: dir, changedFiles: ['scripts/lib/review-file-writer.js'] });
  assert.equal(result.ran, true);
  assert.equal(result.passed, false);
  assert.match(result.output, /every skip reason is classified/);
});

test('runTestGate: a passing merged tree proceeds', () => {
  const dir = makeScratchRepo();
  writePassingTest(dir);
  const result = runTestGate({ cwd: dir, changedFiles: ['scripts/lib/review-file-writer.js'] });
  assert.equal(result.ran, true);
  assert.equal(result.passed, true);
});

test('runTestGate: skips (passed=true, ran=false) when no scripts/lib/ file changed', () => {
  const dir = makeScratchRepo();
  writeFailingTest(dir); // present but irrelevant — nothing under scripts/lib/ changed
  const result = runTestGate({ cwd: dir, changedFiles: ['src/app.tsx'] });
  assert.equal(result.ran, false);
  assert.equal(result.passed, true);
});

test('runTestGate: skips (passed=true, ran=false) when scripts/lib/ changed but no colocated test exists yet', () => {
  const dir = makeScratchRepo();
  const result = runTestGate({ cwd: dir, changedFiles: ['scripts/lib/brand-new-helper.js'] });
  assert.equal(result.ran, false);
  assert.equal(result.passed, true);
});

test('runTestGate: injectable execFn is not called when the gate does not apply', () => {
  const dir = makeScratchRepo();
  let called = false;
  const result = runTestGate({
    cwd: dir,
    changedFiles: ['src/app.tsx'],
    execFn: () => {
      called = true;
      return { status: 1, stdout: '', stderr: '' };
    },
  });
  assert.equal(called, false);
  assert.equal(result.passed, true);
});

// --- CLI end-to-end: real spawn, real exit code (proves "non-zero, no push"
// is actually enforceable from the shell caller's perspective) ---

const CLI_PATH = path.join(__dirname, 'merge-post-merge-test-gate.js');

test('CLI: exits non-zero when the merged tree fails a colocated test', () => {
  const dir = makeScratchRepo();
  writeFailingTest(dir);
  // MERGE_TEST_GATE_SKIP_BASELINE=1: this test targets the base pass/fail exit
  // contract, not baseline-diff behavior (covered separately below) — without
  // the kill switch, CLI_PATH is the REAL scripts/lib/merge-post-merge-test-gate.js,
  // so its lazy require('./acceptance-check-core.js') would resolve to the
  // REAL module and attempt a real network `git fetch` against this repo.
  const proc = spawnSync(process.execPath, [CLI_PATH], {
    cwd: dir,
    input: 'scripts/lib/review-file-writer.js\n',
    encoding: 'utf8',
    env: { ...process.env, MERGE_TEST_GATE_SKIP_BASELINE: '1' },
  });
  assert.notEqual(proc.status, 0);
});


test('CLI: exits 0 when the merged tree passes', () => {
  const dir = makeScratchRepo();
  writePassingTest(dir);
  const proc = spawnSync(process.execPath, [CLI_PATH], {
    cwd: dir,
    input: 'scripts/lib/review-file-writer.js\n',
    encoding: 'utf8',
  });
  assert.equal(proc.status, 0);
});

test('CLI: exits 0 when nothing under scripts/lib/ changed', () => {
  const dir = makeScratchRepo();
  const proc = spawnSync(process.execPath, [CLI_PATH], {
    cwd: dir,
    input: 'src/app.tsx\n',
    encoding: 'utf8',
  });
  assert.equal(proc.status, 0);
});

// --- diffFailingSets: the pure unit the acceptance criteria's "two fixture
// failing-sets" test targets directly (card #1433) ---

test('diffFailingSets: a NEW failure not in the baseline set is reported as new', () => {
  const baseline = new Map([['a.test.mjs::old', { file: 'a.test.mjs', name: 'old' }]]);
  const merged = new Map([
    ['a.test.mjs::old', { file: 'a.test.mjs', name: 'old' }],
    ['b.test.mjs::brand-new', { file: 'b.test.mjs', name: 'brand-new' }],
  ]);
  const { newFailures, preExisting } = diffFailingSets(baseline, merged);
  assert.deepEqual(newFailures, [{ file: 'b.test.mjs', name: 'brand-new' }]);
  assert.deepEqual(preExisting, [{ file: 'a.test.mjs', name: 'old' }]);
});

test('diffFailingSets: an unlocated (?::) merged failure is ALWAYS new, even if baseline has an unlocated failure sharing the same title', () => {
  // Codex adversarial review (card #1433): two DIFFERENT unlocated failures
  // with the same title collapse to the same `?::<name>` key across two
  // separate process runs — matching them against baseline would let a
  // genuinely new failure silently read as pre-existing.
  const key = '?::cleanup';
  const baseline = new Map([[key, { file: '?', name: 'cleanup' }]]);
  const merged = new Map([[key, { file: '?', name: 'cleanup' }]]);
  const { newFailures, preExisting } = diffFailingSets(baseline, merged);
  assert.deepEqual(newFailures, [{ file: '?', name: 'cleanup' }]);
  assert.deepEqual(preExisting, []);
});

test('diffFailingSets: a failure present in BOTH sets is pre-existing, not new', () => {
  const key = 'a.test.mjs::flaky';
  const value = { file: 'a.test.mjs', name: 'flaky' };
  const baseline = new Map([[key, value]]);
  const merged = new Map([[key, value]]);
  const { newFailures, preExisting } = diffFailingSets(baseline, merged);
  assert.deepEqual(newFailures, []);
  assert.deepEqual(preExisting, [value]);
});

test('diffFailingSets: a failure fixed in the merged tree (present in baseline only) is absent from both lists', () => {
  const baseline = new Map([['a.test.mjs::now-fixed', { file: 'a.test.mjs', name: 'now-fixed' }]]);
  const merged = new Map();
  const { newFailures, preExisting } = diffFailingSets(baseline, merged);
  assert.deepEqual(newFailures, []);
  assert.deepEqual(preExisting, []);
});

test('diffFailingSets: empty baseline and empty merged sets produce empty results', () => {
  const { newFailures, preExisting } = diffFailingSets(new Map(), new Map());
  assert.deepEqual(newFailures, []);
  assert.deepEqual(preExisting, []);
});

// --- runTestGate baseline mode: the acceptance criteria's two end-to-end
// scenarios, using a real (but tiny/fast) `node --test` spawn against scratch
// repos and an INJECTED makeBaselineCheckout/removeBaselineCheckout — never
// touches real git or network. ---

test('runTestGate baseline mode: a branch that ADDS a new failure is still blocked', () => {
  const baselineDir = makeScratchRepo();
  writeFailingTest(baselineDir, 'old.test.mjs'); // pre-existing, already red on "origin/main"

  const mergedDir = makeScratchRepo();
  writeFailingTest(mergedDir, 'old.test.mjs'); // same pre-existing failure, unchanged
  writeFailingTest(mergedDir, 'new.test.mjs'); // this branch's own new failure

  let removed = null;
  const result = runTestGate({
    cwd: mergedDir,
    changedFiles: ['scripts/lib/review-file-writer.js'],
    makeBaselineCheckout: () => ({ dir: baselineDir, prepared: true }),
    removeBaselineCheckout: (co) => { removed = co; },
  });

  assert.equal(result.passed, false);
  assert.match(result.output, /NEW since origin\/main/);
  assert.match(result.output, /new\.test\.mjs::every skip reason is classified/);
  assert.match(result.output, /pre-existing on origin\/main/);
  assert.match(result.output, /old\.test\.mjs::every skip reason is classified/);
  assert.equal(removed.dir, baselineDir);
});

test('runTestGate baseline mode: a branch that merely does not fix a pre-existing failure is NOT blocked, but warns loudly', () => {
  const baselineDir = makeScratchRepo();
  writeFailingTest(baselineDir, 'old.test.mjs');

  const mergedDir = makeScratchRepo();
  writeFailingTest(mergedDir, 'old.test.mjs'); // identical pre-existing failure, nothing new

  const result = runTestGate({
    cwd: mergedDir,
    changedFiles: ['scripts/lib/review-file-writer.js'],
    makeBaselineCheckout: () => ({ dir: baselineDir, prepared: true }),
    removeBaselineCheckout: () => {},
  });

  assert.equal(result.passed, true);
  assert.match(result.output, /pre-existing on origin\/main/);
  assert.match(result.reason, /0 new, 1 pre-existing/);
});

test('runTestGate baseline mode: a passing merged tree never invokes makeBaselineCheckout (zero cost on the clean path)', () => {
  const dir = makeScratchRepo();
  writePassingTest(dir);
  let called = false;
  const result = runTestGate({
    cwd: dir,
    changedFiles: ['scripts/lib/review-file-writer.js'],
    makeBaselineCheckout: () => { called = true; return { dir, prepared: true }; },
    removeBaselineCheckout: () => {},
  });
  assert.equal(called, false);
  assert.equal(result.passed, true);
});

test('runTestGate baseline mode: a baseline checkout that throws fails SAFE — blocks like the pre-#1433 behavior, not silently passed through', () => {
  const dir = makeScratchRepo();
  writeFailingTest(dir);
  const result = runTestGate({
    cwd: dir,
    changedFiles: ['scripts/lib/review-file-writer.js'],
    makeBaselineCheckout: () => { throw new Error('worktree add failed: lock contended'); },
    removeBaselineCheckout: () => {},
  });
  assert.equal(result.passed, false);
  assert.match(result.output, /could not build an origin\/main baseline/);
  assert.match(result.output, /worktree add failed: lock contended/);
});

test('runTestGate baseline mode: an UNPREPARED baseline checkout (missing node_modules) fails SAFE instead of trusting a masked-environment result', () => {
  const dir = makeScratchRepo();
  writeFailingTest(dir);
  const result = runTestGate({
    cwd: dir,
    changedFiles: ['scripts/lib/review-file-writer.js'],
    // prepared:false — same shape acceptance-check-core.js's makeFreshCheckout
    // returns when node_modules linking failed. If this were trusted as a
    // real baseline (e.g. treated as "zero baseline failures"), EVERY merged
    // failure would misread as "new" or worse, a masked require() failure in
    // the baseline run could misread as "everything's pre-existing" — the
    // opposite of fail-safe. Must block, same as the throw case above.
    makeBaselineCheckout: () => ({ dir, prepared: false }),
    removeBaselineCheckout: () => {},
  });
  assert.equal(result.passed, false);
  assert.match(result.output, /could not build an origin\/main baseline/);
  assert.match(result.output, /unprepared/);
});

test('runTestGate: merged run exits non-zero but parses ZERO failures (crash/syntax-error, not an assertion failure) fails SAFE and never attempts a baseline', () => {
  // Codex adversarial review (card #1433): a nonzero exit with nothing
  // parseable (crash before any test ran, unsupported reporter, timeout)
  // must not silently diff to "0 new failures" and pass.
  const dir = makeScratchRepo();
  writeFailingTest(dir); // gives listColocatedTestFiles a file to find; execFn below is mocked, so its content is irrelevant
  let baselineCalled = false;
  const result = runTestGate({
    cwd: dir,
    changedFiles: ['scripts/lib/review-file-writer.js'],
    execFn: () => ({ status: 1, stdout: 'FATAL ERROR: JavaScript heap out of memory\n', stderr: '' }),
    makeBaselineCheckout: () => { baselineCalled = true; return { dir, prepared: true }; },
    removeBaselineCheckout: () => {},
  });
  assert.equal(result.passed, false);
  assert.equal(baselineCalled, false, 'must not spend a baseline checkout on an unparseable merged run');
  assert.match(result.output, /no individual test failure could be parsed/);
});

test('runTestGate baseline mode: a baseline run that exits non-zero with ZERO parsed failures (crash) is treated as baseline-unavailable, not "zero pre-existing failures" — fails SAFE', () => {
  const dir = makeScratchRepo();
  writeFailingTest(dir); // needs a real .test.mjs file so listColocatedTestFiles doesn't short-circuit; execFn below is mocked
  const baselineDir = makeScratchRepo();
  writeFailingTest(baselineDir); // needs a real .test.mjs file so listColocatedTestFiles doesn't short-circuit and skip calling execFn for the baseline run
  const mergedTap =
    "TAP version 13\nnot ok 1 - a real failure\n  ---\n  location: '" +
    dir +
    "/scripts/lib/contract.test.mjs:5:1'\n  ...\n# tests 1\n# fail 1\n";
  const result = runTestGate({
    cwd: dir,
    changedFiles: ['scripts/lib/review-file-writer.js'],
    execFn: (execCwd) => {
      if (execCwd === dir) return { status: 1, stdout: mergedTap, stderr: '' };
      // baseline: crashed before producing any parseable TAP failure
      return { status: 1, stdout: 'FATAL ERROR: JavaScript heap out of memory\n', stderr: '' };
    },
    makeBaselineCheckout: () => ({ dir: baselineDir, prepared: true }),
    removeBaselineCheckout: () => {},
  });
  assert.equal(result.passed, false);
  assert.match(result.output, /could not build an origin\/main baseline/);
  assert.match(result.output, /cannot trust it as "zero pre-existing failures"/);
});
