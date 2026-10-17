import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { nextIdleOnSuccess, nextSleepMs } = require('./cyrus-drain-backoff.js');

const INTERVAL_MS = 2000;
const IDLE_MAX_MS = 20000;

test('BRO-4375: idle backoff doubles on consecutive empty polls, capped at IDLE_MAX_MS', () => {
  let idle = INTERVAL_MS;
  const seen = [];
  for (let i = 0; i < 7; i++) {
    idle = nextIdleOnSuccess(0, idle, INTERVAL_MS, IDLE_MAX_MS);
    seen.push(idle);
  }
  assert.deepEqual(seen, [4000, 8000, 16000, 20000, 20000, 20000, 20000]);
});

test('BRO-4375: any non-empty poll snaps idle straight back to INTERVAL_MS', () => {
  const idle = nextIdleOnSuccess(3, 20000, INTERVAL_MS, IDLE_MAX_MS);
  assert.equal(idle, INTERVAL_MS);
});

test('BRO-4375: nextSleepMs always picks the larger of backoff and idle', () => {
  assert.equal(nextSleepMs(2000, 16000), 16000);
  assert.equal(nextSleepMs(60000, 2000), 60000);
  assert.equal(nextSleepMs(2000, 2000), 2000);
});
