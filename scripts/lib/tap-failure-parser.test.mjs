import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { parseTapOutput } = require('./tap-failure-parser.js');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('parseTapOutput: keys a located failure by repo-relative-file::name', () => {
  const tap = [
    'TAP version 13',
    'not ok 1 - every skip reason is classified',
    '  ---',
    "  location: '/repo/scripts/lib/review-file-writer.test.mjs:5:1'",
    '  ...',
    '# tests 1',
    '# fail 1',
  ].join('\n');
  const { failures, totals, sawTap, unlocated } = parseTapOutput(tap, '/repo');
  assert.deepEqual([...failures.keys()], ['scripts/lib/review-file-writer.test.mjs::every skip reason is classified']);
  assert.equal(totals.tests, 1);
  assert.equal(totals.fail, 1);
  assert.equal(sawTap, true);
  assert.equal(unlocated, 0);
});

test('parseTapOutput: two different files with the SAME test title stay distinct keys', () => {
  const tap = [
    'not ok 1 - two child processes racing to save both land without corrupting the file',
    "  location: '/repo/scripts/lib/json-write-guard.test.mjs:10:1'",
    'not ok 2 - two child processes racing to save both land without corrupting the file',
    "  location: '/repo/scripts/lib/commercial-write-guard.test.mjs:12:1'",
  ].join('\n');
  const { failures } = parseTapOutput(tap, '/repo');
  assert.equal(failures.size, 2);
  assert.ok(failures.has('scripts/lib/json-write-guard.test.mjs::two child processes racing to save both land without corrupting the file'));
  assert.ok(failures.has('scripts/lib/commercial-write-guard.test.mjs::two child processes racing to save both land without corrupting the file'));
});

test('parseTapOutput: a failure with no location: line falls back to a ?:: key and counts as unlocated', () => {
  const tap = [
    'not ok 1 - mystery failure',
    'ok 2 - some other test',
  ].join('\n');
  const { failures, unlocated } = parseTapOutput(tap, '/repo');
  assert.deepEqual([...failures.keys()], ['?::mystery failure']);
  assert.equal(unlocated, 1);
});

test('parseTapOutput: two DIFFERENT absolute roots produce the SAME key for the same repo-relative path', () => {
  const makeTap = (absFile) =>
    [`not ok 1 - foo`, `  location: '${absFile}:1:1'`].join('\n');
  const a = parseTapOutput(makeTap('/tmp/baseline-xyz/scripts/lib/foo.test.mjs'), '/tmp/baseline-xyz');
  const b = parseTapOutput(makeTap('/repo/main-worktree/scripts/lib/foo.test.mjs'), '/repo/main-worktree');
  assert.deepEqual([...a.failures.keys()], [...b.failures.keys()]);
  assert.deepEqual([...a.failures.keys()], ['scripts/lib/foo.test.mjs::foo']);
});

test('parseTapOutput: empty output — no failures, sawTap false', () => {
  const { failures, sawTap, totals } = parseTapOutput('', '/repo');
  assert.equal(failures.size, 0);
  assert.equal(sawTap, false);
  assert.equal(totals.tests, null);
});

// Real spawn: end-to-end proof the regexes match Node's ACTUAL TAP reporter
// output, not just a hand-written fixture string.
test('parseTapOutput: matches real `node --test --test-reporter=tap` output', async () => {
  const { spawnSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-parser-real-'));
  const testFile = path.join(dir, 'real.test.mjs');
  fs.writeFileSync(
    testFile,
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('real failure', () => { assert.equal(1, 2); });\n"
  );
  // NODE_TEST_CONTEXT is set in THIS process's env (we're running under
  // `node --test` ourselves) — a nested child inherits it and reports over an
  // IPC channel instead of real TAP stdout, same footgun
  // merge-post-merge-test-gate.js's defaultExec() strips for the same reason.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const res = spawnSync(process.execPath, ['--test', '--test-reporter=tap', testFile], { encoding: 'utf8', env });
  // realpath: on macOS os.tmpdir() is under a symlink (/var/folders/... ->
  // /private/var/folders/...) but node's TAP `location:` line reports the
  // resolved path — path.relative(dir, resolvedAbs) without this produces a
  // bogus `../../../private/var/...` key instead of `real.test.mjs::...`.
  const { failures } = parseTapOutput(`${res.stdout}${res.stderr}`, fs.realpathSync(dir));
  assert.deepEqual([...failures.keys()], ['real.test.mjs::real failure']);
});
