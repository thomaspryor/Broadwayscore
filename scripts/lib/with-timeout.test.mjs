import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { withTimeout } = require('./with-timeout');
const { findUnclearedTimeoutRaces } = require('./timeout-pattern-audit');
const { audit } = require('../audit-timeout-patterns');

test('resolves fast work without leaving a live timer', async () => {
  const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  assert.equal(await withTimeout(Promise.resolve(7), 60_000), 7);
  const after = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  assert.equal(after, before);
});

test('clears the timer when the work rejects', async () => {
  const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  await assert.rejects(withTimeout(Promise.reject(new Error('boom')), 60_000), /boom/);
  assert.equal(process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length, before);
});

test('rejects with label / message on timeout', async () => {
  await assert.rejects(withTimeout(new Promise(() => {}), 10, { label: 'tier' }), /tier timed out after 10ms/);
  await assert.rejects(withTimeout(new Promise(() => {}), 10, { message: 'custom' }), /^Error: custom$/);
});

test('resolveWith resolves instead of rejecting, and accepts a function', async () => {
  assert.equal(await withTimeout(new Promise(() => {}), 10, { resolveWith: 'late' }), 'late');
  assert.equal(await withTimeout(() => Promise.resolve('ok'), 1000), 'ok');
});

test('detector flags the bare pattern and accepts cleared/unref forms', () => {
  const bare = `await Promise.race([\n work(),\n new Promise((_, rej) => setTimeout(() => rej(new Error('t')), 5)),\n]);`;
  assert.equal(findUnclearedTimeoutRaces(bare).length, 1);
  assert.equal(findUnclearedTimeoutRaces(bare + '\nclearTimeout(timer);').length, 0);
  assert.equal(findUnclearedTimeoutRaces('await Promise.race([a, new Promise(r => setTimeout(r, 5).unref())]);').length, 0);
  assert.equal(findUnclearedTimeoutRaces('await Promise.race([a, b]);').length, 0);
});

test('detector catches a Promise\\n.race( split across lines', () => {
  const src = 'await Promise\n  .race([\n work(),\n new Promise((_, r) => setTimeout(r, 5)),\n]);';
  assert.equal(findUnclearedTimeoutRaces(src).length, 1);
});

test('ms guard: 0 disables, invalid values throw', async () => {
  assert.equal(await withTimeout(Promise.resolve('x'), 0), 'x');
  await assert.rejects(withTimeout(Promise.resolve('x'), NaN), /invalid ms/);
  await assert.rejects(withTimeout(Promise.resolve('x'), -5), /invalid ms/);
});

test('ratchet: no uncleared Promise.race timeouts in scripts/ or src/', () => {
  assert.deepEqual(audit(), []);
});
