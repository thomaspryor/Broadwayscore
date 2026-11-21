// BRO-4623: runMain is what makes an entry point exit once main() settles.
// commercial-friday run 37083591866 printed its SUMMARY at 01:04 and was
// cancelled by the job timeout at 01:48 because nothing ever exited.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runMain } = require('./run-main.js');

const quietLog = { error: () => {} };

test('resolving main: teardown runs after main, then exit(0)', async () => {
  const order = [];
  let exitCode = null;
  await runMain(async () => { order.push('main'); }, {
    teardown: [async () => { order.push('teardown'); }],
    exit: (c) => { order.push('exit'); exitCode = c; },
    log: quietLog,
  });
  assert.deepEqual(order, ['main', 'teardown', 'exit']);
  assert.equal(exitCode, 0);
});

test('rejecting main: teardown still runs, exit(1)', async () => {
  let tornDown = false;
  let exitCode = null;
  await runMain(async () => { throw new Error('boom'); }, {
    teardown: [() => { tornDown = true; }],
    exit: (c) => { exitCode = c; },
    log: quietLog,
  });
  assert.equal(tornDown, true);
  assert.equal(exitCode, 1);
});

test('a non-zero process.exitCode set by main is preserved', async () => {
  const saved = process.exitCode;
  let exitCode = null;
  try {
    await runMain(async () => { process.exitCode = 3; }, { exit: (c) => { exitCode = c; }, log: quietLog });
  } finally {
    process.exitCode = saved;
  }
  assert.equal(exitCode, 3);
});

test('a hung teardown is bounded: exit still happens', async () => {
  let exitCode = null;
  const t0 = Date.now();
  await runMain(async () => {}, {
    teardown: [() => new Promise(() => {})],
    teardownTimeoutMs: 50,
    exit: (c) => { exitCode = c; },
    log: quietLog,
  });
  assert.equal(exitCode, 0);
  assert.ok(Date.now() - t0 < 2000, 'teardown bound must apply');
});

test('a throwing teardown does not stop the next one or the exit', async () => {
  const ran = [];
  let exitCode = null;
  await runMain(async () => {}, {
    teardown: [() => { throw new Error('first'); }, () => { ran.push('second'); }],
    exit: (c) => { exitCode = c; },
    log: quietLog,
  });
  assert.deepEqual(ran, ['second']);
  assert.equal(exitCode, 0);
});
