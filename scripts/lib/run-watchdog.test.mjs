// BRO-4401: the image fetcher's --max-runtime was only checked between
// batches, so a fetch that never returned ran until the job was cancelled at
// 160 min with finished work never checkpointed. armRunWatchdog is the hard
// deadline that fires regardless of what is in flight.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { armRunWatchdog } = require('./run-watchdog.js');

function fakeTimer() {
  const calls = [];
  const setTimer = (fn, ms) => { const h = { fn, ms, unrefd: false, unref() { this.unrefd = true; } }; calls.push(h); return h; };
  return { calls, setTimer };
}

test('fires at budget + grace, runs onFire, then exits with the given code; the timer is unref()d', () => {
  const { calls, setTimer } = fakeTimer();
  const events = [];
  const armed = armRunWatchdog({
    maxRuntimeMin: 150, graceMin: 10,
    onFire: () => events.push('checkpoint'),
    exitCode: 0,
    setTimer, exit: (c) => events.push(`exit:${c}`), log: (m) => events.push(m),
  });
  assert.equal(armed.fireAtMs, 160 * 60 * 1000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].unrefd, true, 'a normal finish must not be held open by the watchdog');
  calls[0].fn();
  assert.deepEqual(events.filter((e) => !String(e).startsWith('::warning')), ['checkpoint', 'exit:0']);
  assert.match(events[0], /Run watchdog/);
});

test('a throwing onFire still exits (the exit is the point, the checkpoint is best effort)', () => {
  const { calls, setTimer } = fakeTimer();
  const events = [];
  armRunWatchdog({ maxRuntimeMin: 5, graceMin: 1, onFire: () => { throw new Error('disk full'); }, setTimer, exit: (c) => events.push(`exit:${c}`), log: (m) => events.push(m) });
  calls[0].fn();
  assert.ok(events.some((e) => /onFire threw: disk full/.test(e)));
  assert.equal(events[events.length - 1], 'exit:0');
});

test('no budget (0, missing, NaN) → disarmed, no timer', () => {
  const { calls, setTimer } = fakeTimer();
  assert.equal(armRunWatchdog({ maxRuntimeMin: 0, onFire() {}, setTimer }), null);
  assert.equal(armRunWatchdog({ maxRuntimeMin: NaN, onFire() {}, setTimer }), null);
  assert.equal(armRunWatchdog({ maxRuntimeMin: undefined, onFire() {}, setTimer }), null);
  assert.equal(calls.length, 0);
});
