import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { runVerify } = require('./acceptance-check-core.js');

function tmpCheckout() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-check-core-test-'));
}

// BRO-3446: --allow-phantom-path (or a since-renamed/deleted file) can freeze
// an acceptance command naming a path that was never created. isSafeCheckCommand
// only validates shape, so the command reaches runVerify, node exits non-zero
// on the missing module, and the pre-fix behaviour reported `fail` — read by
// the nightly recheck as "this card's fix no longer works" for a card whose
// fix is correct and live. This must report `unverifiable` instead.
test('BRO-3446: a command naming a path absent from the checkout is unverifiable, not fail', () => {
  const cwd = tmpCheckout();
  try {
    const out = runVerify(cwd, 'node --test tests/unit/does-not-exist.test.mjs', { attempts: 1 });
    assert.equal(out.status, 'unverifiable');
    assert.match(out.detail, /tests\/unit\/does-not-exist\.test\.mjs/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('BRO-3446: the guard does not mask a real failure once the path exists', () => {
  const cwd = tmpCheckout();
  try {
    fs.mkdirSync(path.join(cwd, 'tests/unit'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, 'tests/unit/broken.test.mjs'),
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('broken', () => { assert.equal(1, 2); });\n",
    );
    const out = runVerify(cwd, 'node --test tests/unit/broken.test.mjs', { attempts: 1 });
    assert.equal(out.status, 'fail');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('BRO-3446: a command whose path DOES exist still runs and can pass', () => {
  const cwd = tmpCheckout();
  try {
    fs.mkdirSync(path.join(cwd, 'tests/unit'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, 'tests/unit/ok.test.mjs'),
      "import test from 'node:test';\ntest('ok', () => {});\n",
    );
    const out = runVerify(cwd, 'node --test tests/unit/ok.test.mjs', { attempts: 1 });
    assert.equal(out.status, 'pass');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// BRO-4241: only the shallow clone's "can't deepen" failure falls back to a
// standalone clone; timeouts, lock contention and pinned shas fail as before.
test('shouldCloneAfterFetchFailure: only the unshallow failure, never pinned or timed out', () => {
  const { shouldCloneAfterFetchFailure } = require('./acceptance-check-core.js');
  const unshallow = Object.assign(new Error('Command failed: git fetch --deepen=200 origin main'), { stderr: Buffer.from('fatal: error in object: unshallow 3d8ddac0cc42d7f7e400eafe9bc0405097075768\n') });
  assert.equal(shouldCloneAfterFetchFailure(unshallow, null), true);
  assert.equal(shouldCloneAfterFetchFailure(unshallow, 'abc123'), false);
  const timedOut = Object.assign(new Error('spawnSync git ETIMEDOUT'), { signal: 'SIGTERM', stderr: Buffer.from('unshallow') });
  assert.equal(shouldCloneAfterFetchFailure(timedOut, null), false);
  const lock = Object.assign(new Error('Command failed'), { stderr: Buffer.from("fatal: Unable to create '/x/.git/shallow.lock': File exists.") });
  assert.equal(shouldCloneAfterFetchFailure(lock, null), false);
  assert.equal(shouldCloneAfterFetchFailure(null, null), false);
});
