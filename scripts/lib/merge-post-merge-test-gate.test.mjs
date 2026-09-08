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

// BRO-2874. The gate's `reason` is the ONLY line an operator reads when
// scripts/merge-worktree-to-main.sh dies, and it used to report `status=null`
// for every spawn-layer failure — discarding `result.error`, the one field that
// names the real cause. Four field reproductions blamed "a NEW-since-origin/main
// colocated test failure" for runs where the tree was clean and the CHILD died.
// Mutating the source proves each conjunct: dropping the `signal` push fails the
// SIGTERM assertion, dropping the `error` push fails the ENOBUFS assertions in
// BOTH the baseline and skip-baseline tests, and reverting describeExit at the
// skip-baseline return fails only the fourth test.
// Regression guard, NOT a proof of the BRO-2874 change: the pre-fix code
// interpolated `status=${result.status}` and would have passed this too. It
// exists so that a later refactor of describeExit cannot drop the status from
// the baseline-path call site. The three tests below it are the ones that fail
// against pre-fix code.
test('runTestGate: a child that exits non-zero with unparseable output names its real exit status (BRO-2874 status=7)', () => {
  const dir = makeScratchRepo();
  writeFailingTest(dir);
  const result = runTestGate({
    cwd: dir,
    changedFiles: ['scripts/lib/review-file-writer.js'],
    execFn: () => ({ status: 7, stdout: '', stderr: 'Segmentation fault\n' }),
    makeBaselineCheckout: () => ({ dir, prepared: true }),
    removeBaselineCheckout: () => {},
  });
  assert.equal(result.passed, false);
  assert.match(result.reason, /status=7/);
});

test('runTestGate: a spawn-layer failure names the errno and the signal instead of "status=null" (BRO-2874)', () => {
  const dir = makeScratchRepo();
  writeFailingTest(dir);
  const result = runTestGate({
    cwd: dir,
    changedFiles: ['scripts/lib/review-file-writer.js'],
    execFn: () => ({
      status: null,
      signal: 'SIGTERM',
      error: Object.assign(new Error('spawnSync node ENOBUFS'), { code: 'ENOBUFS' }),
      stdout: '',
      stderr: '',
    }),
    makeBaselineCheckout: () => ({ dir, prepared: true }),
    removeBaselineCheckout: () => {},
  });
  assert.equal(result.passed, false);
  assert.match(result.reason, /ENOBUFS/, 'the errno must survive into the reason — it was discarded before BRO-2874');
  assert.match(result.reason, /SIGTERM/, 'a timeout kill must be named, not reported as status=null');
});

test('runTestGate: surfacing spawn error/signal changes NO pass/fail decision — status 0 still passes', () => {
  // The invariant that pins the BRO-2874 fix as message-only. `mergedPassed` is
  // `result.status === 0`; if anyone later folds `result.error` into that
  // predicate, this flips to false and this test fails.
  const dir = makeScratchRepo();
  writeFailingTest(dir);
  const result = runTestGate({
    cwd: dir,
    changedFiles: ['scripts/lib/review-file-writer.js'],
    execFn: () => ({
      status: 0,
      signal: 'SIGTERM',
      error: Object.assign(new Error('spawnSync node ENOBUFS'), { code: 'ENOBUFS' }),
      stdout: '',
      stderr: '',
    }),
    makeBaselineCheckout: () => ({ dir, prepared: true }),
    removeBaselineCheckout: () => {},
  });
  assert.equal(result.passed, true, 'status===0 is the sole pass predicate; error/signal must not block');
});

test('runTestGate with baseline DISABLED (MERGE_TEST_GATE_SKIP_BASELINE=1) still names the real cause — the escape hatch the die text recommends must not be worse (BRO-2874)', () => {
  // This return is the one the original fix missed: it reported `ran N file(s):`
  // followed by every selected filename, with no exit detail at all.
  const dir = makeScratchRepo();
  writeFailingTest(dir);
  const result = runTestGate({
    cwd: dir,
    changedFiles: ['scripts/lib/review-file-writer.js'],
    execFn: () => ({
      status: null,
      signal: 'SIGTERM',
      error: Object.assign(new Error('spawnSync node ENOBUFS'), { code: 'ENOBUFS' }),
      stdout: '',
      stderr: '',
    }),
    makeBaselineCheckout: null,
    removeBaselineCheckout: () => {},
  });
  assert.equal(result.passed, false);
  assert.match(result.reason, /ENOBUFS/);
  assert.match(result.reason, /SIGTERM/);
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

// --- BRO-2785: .github/workflows/** is a covered change class ---
//
// Before this, a diff touching ONLY .github/workflows/** selected zero test
// files, so runTestGate returned {ran:false, passed:true} and the integration
// script printed a clean green. A 504-char line then reddened main against
// tests/unit/workflow-line-length.test.mjs, with CI on main as the first
// signal. These tests pin the whole chain: the predicate, the discovery, the
// merged/baseline set alignment, and the end-to-end "it actually runs".

const {
  touchesLib,
  touchesWorkflows,
  listWorkflowGuardTestFiles,
  selectTestFiles,
  REQUIRED_WORKFLOW_GUARDS,
  EXCLUDED_WORKFLOW_GUARDS,
} = require('./merge-post-merge-test-gate.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// The reason REQUIRED_WORKFLOW_GUARDS exists: workflow-line-length.test.mjs
// builds its path from separate '.github' + 'workflows' path.join() segments,
// so the only contiguous ".github/workflows" in that file is its test TITLE.
// Content discovery matches it by accident. If someone rewords the title, a
// discovery-only gate would silently stop running the exact guard BRO-2785 is
// about — invisible non-execution, the same failure class as the original bug.
test('REQUIRED_WORKFLOW_GUARDS: every listed guard exists in the repo', () => {
  for (const rel of REQUIRED_WORKFLOW_GUARDS) {
    assert.ok(
      fs.existsSync(path.join(REPO_ROOT, rel)),
      `${rel} is pinned as a required workflow guard but is missing — it was renamed or deleted, and the floor would silently stop running it`
    );
  }
});

test('REQUIRED_WORKFLOW_GUARDS: the line-length guard is selected even when its content never mentions the workflows dir', () => {
  const dir = makeScratchRepo();
  const unitDir = path.join(dir, 'tests', 'unit');
  fs.mkdirSync(unitDir, { recursive: true });
  // Deliberately contains NO ".github/workflows" substring — this is the file
  // as it would look after an innocuous title reword.
  fs.writeFileSync(
    path.join(unitDir, 'workflow-line-length.test.mjs'),
    "import { test } from 'node:test';\ntest('no workflow yaml line is too long', () => {});\n"
  );
  const selected = selectTestFiles(dir, [path.posix.join('.github/workflows', 'a.yml')]);
  assert.ok(
    selected.includes(path.join('tests', 'unit', 'workflow-line-length.test.mjs')),
    'required guard must be selected by name, not by content discovery'
  );
});

test('EXCLUDED_WORKFLOW_GUARDS: an excluded guard is never selected even though its content matches discovery', () => {
  const dir = makeScratchRepo();
  const unitDir = path.join(dir, 'tests', 'unit');
  fs.mkdirSync(unitDir, { recursive: true });
  for (const rel of EXCLUDED_WORKFLOW_GUARDS) {
    fs.writeFileSync(
      path.join(dir, rel),
      "import { test } from 'node:test';\n// subject: .github/workflows\ntest('live api', () => {});\n"
    );
  }
  const selected = selectTestFiles(dir, [path.posix.join('.github/workflows', 'a.yml')]);
  for (const rel of EXCLUDED_WORKFLOW_GUARDS) {
    assert.ok(!selected.includes(rel), `${rel} is excluded and must not run in the local floor`);
  }
});

test('EXCLUDED_WORKFLOW_GUARDS: the live-API guard is excluded, so the real repo set is failure-free and never needs a baseline', () => {
  // If this ever regresses, every workflow merge pays a baseline checkout for
  // a failure that was never actionable, and MERGE_TEST_GATE_SKIP_BASELINE=1
  // becomes an outright block.
  const selected = selectTestFiles(REPO_ROOT, [path.posix.join('.github/workflows', 'a.yml')]);
  assert.ok(selected.length > 0, 'the real repo must select some workflow guards');
  assert.ok(
    !selected.includes(path.join('tests', 'unit', 'branch-protection.test.mjs')),
    'branch-protection.test.mjs needs an admin token and must stay excluded'
  );
});

const WORKFLOW_DIR = path.join('.github', 'workflows');

function seedWorkflowGuard(dir, name, { mentionsWorkflows = true } = {}) {
  const unitDir = path.join(dir, 'tests', 'unit');
  fs.mkdirSync(unitDir, { recursive: true });
  const body = mentionsWorkflows
    ? "import { test } from 'node:test';\ntest('guards .github/workflows', () => {});\n"
    : "import { test } from 'node:test';\ntest('unrelated', () => {});\n";
  fs.writeFileSync(path.join(unitDir, name), body);
}

test('touchesWorkflows: true only for the .github/workflows/ directory prefix', () => {
  assert.equal(touchesWorkflows([path.posix.join('.github/workflows', 'test.yml')]), true);
  // A path that merely CONTAINS the string is not a workflow file. This one
  // carries the trailing slash too, so it fails unless the check is anchored
  // at the START of the path — `includes` instead of `startsWith` passes the
  // no-slash fixture and must not be allowed to pass here.
  assert.equal(touchesWorkflows(['vendor/.github/workflows/ci.yml']), false);
  assert.equal(touchesWorkflows(['docs/.github/workflows-notes.md']), false);
  assert.equal(touchesWorkflows(['src/app.tsx']), false);
  assert.equal(touchesWorkflows([]), false);
  assert.equal(touchesWorkflows(undefined), false);
});

test('shouldRunTestGate: true for a workflow-ONLY change (the BRO-2785 regression)', () => {
  // This is the exact input that used to return false and skip the floor.
  assert.equal(shouldRunTestGate(['.github/workflows/check-cron-health.yml']), true);
  assert.equal(touchesLib(['.github/workflows/check-cron-health.yml']), false);
});

test('listWorkflowGuardTestFiles: discovers by content, ignores tests that do not mention workflows', () => {
  const dir = makeScratchRepo();
  seedWorkflowGuard(dir, 'wf-guard.test.mjs');
  seedWorkflowGuard(dir, 'unrelated.test.mjs', { mentionsWorkflows: false });
  fs.writeFileSync(path.join(dir, 'tests', 'unit', 'notatest.mjs'), '// .github/workflows\n');
  const found = listWorkflowGuardTestFiles(dir);
  assert.deepEqual(found, [path.join('tests', 'unit', 'wf-guard.test.mjs')]);
});

test('listWorkflowGuardTestFiles: empty when tests/unit does not exist', () => {
  assert.deepEqual(listWorkflowGuardTestFiles(makeScratchRepo()), []);
});

test('selectTestFiles: workflow-only change selects the workflow guards and no lib tests', () => {
  const dir = makeScratchRepo();
  writePassingTest(dir, 'lib-contract.test.mjs');
  seedWorkflowGuard(dir, 'wf-guard.test.mjs');
  const selected = selectTestFiles(dir, [path.posix.join('.github/workflows', 'a.yml')]);
  assert.deepEqual(selected, [path.join('tests', 'unit', 'wf-guard.test.mjs')]);
});

test('selectTestFiles: lib-only change is unchanged — still exactly the colocated tests', () => {
  const dir = makeScratchRepo();
  writePassingTest(dir, 'lib-contract.test.mjs');
  seedWorkflowGuard(dir, 'wf-guard.test.mjs');
  assert.deepEqual(
    selectTestFiles(dir, ['scripts/lib/foo.js']),
    listColocatedTestFiles(dir).sort()
  );
});

test('selectTestFiles: a change touching both classes runs the union, sorted and de-duplicated', () => {
  const dir = makeScratchRepo();
  writePassingTest(dir, 'lib-contract.test.mjs');
  seedWorkflowGuard(dir, 'wf-guard.test.mjs');
  const selected = selectTestFiles(dir, ['scripts/lib/foo.js', path.posix.join('.github/workflows', 'a.yml')]);
  // Assert the LITERAL expected array. Comparing `selected` against
  // `[...selected].sort()` or `new Set(selected)` is a tautology that
  // survives deleting the .sort() and the de-dup entirely (mutation-tested,
  // 2026-09-04) — it asserts the value equals itself.
  assert.deepEqual(selected, [
    path.join('scripts', 'lib', 'lib-contract.test.mjs'),
    path.join('tests', 'unit', 'wf-guard.test.mjs'),
  ]);
});

test('runTestGate: a workflow-only change RUNS and can FAIL — the floor is no longer a silent skip', () => {
  const dir = makeScratchRepo();
  fs.mkdirSync(path.join(dir, 'tests', 'unit'), { recursive: true });
  // Stands in for workflow-line-length.test.mjs: a guard whose subject is a
  // workflow file and which fails on the merged tree.
  fs.writeFileSync(
    path.join(dir, 'tests', 'unit', 'wf-line-length.test.mjs'),
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('no .github/workflows/*.yml line exceeds 500 chars', () => { assert.equal(1, 2, 'line too long'); });\n"
  );
  const result = runTestGate({ cwd: dir, changedFiles: [path.posix.join('.github/workflows', 'probe.yml')] });
  assert.equal(result.ran, true, 'must actually run — ran:false was the bug');
  assert.equal(result.passed, false, 'must block on the workflow guard failure');
  assert.match(result.output, /exceeds 500 chars/);
});

test('runTestGate: an irrelevant diff skips and passes, naming both covered prefixes', () => {
  const result = runTestGate({ cwd: makeScratchRepo(), changedFiles: ['src/app.tsx'] });
  assert.equal(result.ran, false);
  assert.equal(result.passed, true);
  assert.match(result.reason, /scripts\/lib\//);
  assert.match(result.reason, /\.github\/workflows\//);
});

test('runTestGate: a workflow change that selects ZERO guards FAILS — an empty set is a discovery failure, not an all-clear', () => {
  // Tree has no tests/unit at all. Passing here would silently reproduce the
  // original bug: a workflow change validated by nothing, reported green.
  const result = runTestGate({
    cwd: makeScratchRepo(),
    changedFiles: [path.posix.join('.github/workflows', 'a.yml')],
  });
  assert.equal(result.ran, false);
  assert.equal(result.passed, false, 'zero workflow guards must block, not pass');
  assert.match(result.reason, /ZERO workflow guards/);
});

test('mentionsWorkflowsDir: matches the path.join idiom, not just the contiguous literal', () => {
  const dir = makeScratchRepo();
  const unitDir = path.join(dir, 'tests', 'unit');
  fs.mkdirSync(unitDir, { recursive: true });
  // The repo norm: the path is assembled from segments, so the contiguous
  // string never appears. A literal-only scan missed real guards this way.
  fs.writeFileSync(
    path.join(unitDir, 'joined-path.test.mjs'),
    "import path from 'node:path';\nconst p = path.join(root, '.github', 'workflows', 'x.yml');\n"
  );
  fs.writeFileSync(
    path.join(unitDir, 'double-quoted.test.mjs'),
    'const p = path.join(root, ".github", "workflows", "y.yml");\n'
  );
  fs.writeFileSync(path.join(unitDir, 'unrelated.test.mjs'), "const p = 'src/app.tsx';\n");
  const found = listWorkflowGuardTestFiles(dir);
  assert.ok(found.includes(path.join('tests', 'unit', 'joined-path.test.mjs')));
  assert.ok(found.includes(path.join('tests', 'unit', 'double-quoted.test.mjs')));
  assert.ok(!found.includes(path.join('tests', 'unit', 'unrelated.test.mjs')));
});

test('listWorkflowGuardTestFiles: selects the real repo guards that build their path with path.join', () => {
  // Regression pin for two guards a literal-only scan silently skipped.
  const found = listWorkflowGuardTestFiles(REPO_ROOT);
  for (const rel of [
    path.join('tests', 'unit', 'assert-broadcast-step-order.test.mjs'),
    path.join('tests', 'unit', 'stale-announced-audit-scheduled.test.mjs'),
  ]) {
    assert.ok(found.includes(rel), `${rel} is a workflow-subject guard and must be selected`);
  }
});

test('runTestGate: merged and baseline runs select from the SAME change set, so a pre-existing workflow failure does not block', () => {
  // Both trees carry the same failing workflow guard. If the baseline were
  // selected with a different change set it would run nothing, the failure
  // would look NEW, and every workflow merge would be blocked by unrelated
  // pre-existing redness.
  const failingGuard =
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n// subject: .github/workflows\ntest('live: branch protection', () => { assert.equal(1, 2, 'network'); });\n";
  const mk = () => {
    const d = makeScratchRepo();
    fs.mkdirSync(path.join(d, 'tests', 'unit'), { recursive: true });
    fs.writeFileSync(path.join(d, 'tests', 'unit', 'wf-guard.test.mjs'), failingGuard);
    return d;
  };
  const dir = mk();
  const baselineDir = mk();
  const seen = [];
  const result = runTestGate({
    cwd: dir,
    changedFiles: [path.posix.join('.github/workflows', 'a.yml')],
    execFn: (execCwd, testFiles) => {
      seen.push([execCwd, testFiles]);
      return spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...testFiles], {
        cwd: execCwd,
        encoding: 'utf8',
        env: (() => { const e = { ...process.env }; delete e.NODE_TEST_CONTEXT; return e; })(),
      });
    },
    makeBaselineCheckout: () => ({ dir: baselineDir, prepared: true }),
    removeBaselineCheckout: () => {},
  });
  assert.equal(seen.length, 2, 'merged run + baseline run');
  assert.deepEqual(seen[0][1], seen[1][1], 'both runs must execute the same file list');
  assert.equal(result.passed, true, 'a failure present in BOTH trees is pre-existing and must not block');
});
