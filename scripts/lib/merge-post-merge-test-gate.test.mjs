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
const { shouldRunTestGate, listColocatedTestFiles, runTestGate } = require('./merge-post-merge-test-gate.js');

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
  const proc = spawnSync(process.execPath, [CLI_PATH], {
    cwd: dir,
    input: 'scripts/lib/review-file-writer.js\n',
    encoding: 'utf8',
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
