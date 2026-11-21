// BRO-7134: how the Codex runner's land check (scripts/codex/daily-runner.js landFailuresWith)
// grades "new failures on this branch that fresh main does not have". The base side runs only
// the failing files, alone; the branch side ran them inside the full unit batch. A test that
// failed only under batch load (validate-data-push-refusal-sentinel timing out at 300 s, twice)
// passed alone on base and rejected good Codex work. The runner now re-runs the scoped files
// alone on the branch too (computeRerunScope with `isolated`) and judges alone vs alone
// (decideGateDelta). These tests drive the real functions with real `node --test` TAP output:
// a short --test-timeout stands in for batch load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { computeRerunScope, decideGateDelta, parseGateFailures } = require('../../scripts/lib/land-gate-delta.js');

const GATE = 'unit-tests-node';
const SLOW = `import { test } from 'node:test';\ntest('slow but correct', async () => { await new Promise((r) => setTimeout(r, 1500)); });\n`;
const PASS = `import { test } from 'node:test';\ntest('works', () => {});\n`;
const BROKEN = `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('works', () => { assert.equal(1, 2); });\n`;
// A file with a failure main also has, plus a slow test: the case a file-level match got wrong.
const MIXED = `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n`
  + `test('old failure', () => { assert.equal('main', 'fixed'); });\n`
  + `test('slow but correct', async () => { await new Promise((r) => setTimeout(r, 1500)); });\n`;

function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-grading-'));
  mkdirSync(join(dir, 'tests'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, 'tests', name), body);
  return dir;
}
/** One real gate run, as daily-runner.js unitBatch shapes it: { exit, text, root }. */
function run(dir, files, timeoutMs) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // run as a top-level runner, not as a child of this one
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-timeout', String(timeoutMs), ...files], { cwd: dir, env, encoding: 'utf8' });
  return { exit: r.status, text: `${r.stdout}${r.stderr}`, root: dir };
}
const UNDER_LOAD = 500; // the slow test times out, as the sentinel test did inside the batch
const ALONE = 20_000;

test('a timeout under batch load only: scoped for an isolated re-run, passes alone, not counted', (t) => {
  const branch = tree({ 'slow.test.mjs': SLOW, 'ok.test.mjs': PASS });
  t.after(() => rmSync(branch, { recursive: true, force: true }));
  const ran = ['tests/slow.test.mjs', 'tests/ok.test.mjs'];
  const batch = run(branch, ran, UNDER_LOAD);
  assert.notEqual(batch.exit, 0, 'the short timeout must fail the slow file');
  assert.ok([...parseGateFailures(GATE, batch.text, branch).values()].some((f) => /testTimeoutFailure/.test(f.name)), 'real TAP marks it a timeout');

  // land.yml's full-base rule still applies without `isolated`; the runner passes it.
  assert.equal(computeRerunScope({ gate: GATE, branch: batch, branchFiles: ran }).scoped, false);
  const scope = computeRerunScope({ gate: GATE, branch: batch, branchFiles: ran, isolated: true });
  assert.deepEqual(scope.files, ['tests/slow.test.mjs'], scope.reason);

  const alone = run(branch, scope.files, ALONE);
  assert.equal(alone.exit, 0, 'alone it passes: the runner drops the gate before any base run');
  // Before BRO-7134 the batch result was judged against a green alone base run: a false reject.
  const old = decideGateDelta({ gate: GATE, base: { exit: 0, text: '', root: branch }, branch: batch });
  assert.equal(old.verdict, 'fail');
});

test('a real regression still fails when re-run alone and is judged new against base', (t) => {
  const branch = tree({ 'slow.test.mjs': SLOW, 'b.test.mjs': BROKEN });
  const base = tree({ 'slow.test.mjs': SLOW, 'b.test.mjs': PASS });
  t.after(() => { rmSync(branch, { recursive: true, force: true }); rmSync(base, { recursive: true, force: true }); });
  const ran = ['tests/slow.test.mjs', 'tests/b.test.mjs'];
  const batch = run(branch, ran, UNDER_LOAD);
  const scope = computeRerunScope({ gate: GATE, branch: batch, branchFiles: ran, isolated: true });
  assert.deepEqual(scope.files, ran.slice().sort());
  const alone = run(branch, scope.files, ALONE);
  assert.notEqual(alone.exit, 0);
  const d = decideGateDelta({ gate: GATE, base: run(base, scope.files, ALONE), branch: alone });
  assert.equal(d.verdict, 'fail');
  assert.deepEqual(d.newFailures.map((f) => f.file), ['tests/b.test.mjs'], 'only the broken file; the slow one passed alone');
});

test('a failure main also has plus a load-only timeout in the same file: alone vs alone passes', (t) => {
  const branch = tree({ 'mixed.test.mjs': MIXED });
  const base = tree({ 'mixed.test.mjs': MIXED });
  t.after(() => { rmSync(branch, { recursive: true, force: true }); rmSync(base, { recursive: true, force: true }); });
  const ran = ['tests/mixed.test.mjs'];
  const batch = run(branch, ran, UNDER_LOAD);
  const baseAlone = run(base, ran, ALONE);
  // The old comparison (batch vs alone base) counts the timeout as new.
  assert.equal(decideGateDelta({ gate: GATE, base: baseAlone, branch: batch }).verdict, 'fail');
  const scope = computeRerunScope({ gate: GATE, branch: batch, branchFiles: ran, isolated: true });
  assert.equal(scope.scoped, true, scope.reason);
  const d = decideGateDelta({ gate: GATE, base: baseAlone, branch: run(branch, scope.files, ALONE) });
  assert.equal(d.verdict, 'pass', d.reason);
  assert.equal(d.preExisting.length, 1, 'the old failure is pre-existing, not new');
});

test('failures that cannot be scoped keep the batch verdict (no empty or whole-tree re-run)', () => {
  // Unlocated failure: nothing to re-run alone.
  const unlocated = { exit: 1, root: '/x', text: 'TAP version 13\nnot ok 1 - crashed\n  ---\n  failureType: \'testCodeFailure\'\n  ...\n1..1\n' };
  const s = computeRerunScope({ gate: GATE, branch: unlocated, branchFiles: ['tests/a.test.mjs'], isolated: true });
  assert.equal(s.scoped, false);
  assert.deepEqual(s.files, []);
  // A gate with no file list, or a red run with nothing parseable, is never scoped either.
  assert.equal(computeRerunScope({ gate: 'lint-workflows', branch: { exit: 1, text: '' }, branchFiles: null, isolated: true }).scoped, false);
  assert.equal(computeRerunScope({ gate: GATE, branch: { exit: 1, text: 'Segmentation fault' }, branchFiles: ['tests/a.test.mjs'], isolated: true }).scoped, false);
});

test('a batch cut off at its time or output limit is never scoped for an isolated re-run', (t) => {
  // Reviewer P1: a 40-min kill leaves partial TAP; the few timeouts that printed would pass
  // alone and drop the gate although most files never ran. Must keep the batch verdict.
  const branch = tree({ 'slow.test.mjs': SLOW });
  t.after(() => rmSync(branch, { recursive: true, force: true }));
  const ran = ['tests/slow.test.mjs'];
  const done = run(branch, ran, UNDER_LOAD);
  assert.equal(computeRerunScope({ gate: GATE, branch: done, branchFiles: ran, isolated: true }).scoped, true, 'a finished batch is scoped');
  // Killed: spawnSync status null -> sandbox code -1; the summary never printed.
  const cut = done.text.split('\n').filter((l) => !/^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) /.test(l)).join('\n');
  for (const exit of [-1, 1]) {
    const s = computeRerunScope({ gate: GATE, branch: { ...done, exit, text: cut }, branchFiles: ran, isolated: true });
    assert.equal(s.scoped, false, `exit ${exit} without a summary: ${s.reason}`);
  }
  assert.equal(computeRerunScope({ gate: GATE, branch: { ...done, exit: -1 }, branchFiles: ran, isolated: true }).scoped, false, 'killed even with a summary');
});
