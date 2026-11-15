// BRO-7541: replay fetches must survive the shallow-file race that failed every replay run 2026-11-12..15.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { retryFetch, isTransientGitError } = createRequire(import.meta.url)('./push-rescue.js');

const noSleep = () => {};
test('retries the shallow-file race and then succeeds', () => {
  let n = 0; const seen = [];
  const run = (args) => { seen.push(args); n++; if (n < 3) throw new Error('git fetch failed: fatal: shallow file has changed since we read it'); return 'ok'; };
  assert.equal(retryFetch(['--depth=1', 'origin', 'main'], {}, { run, sleep: noSleep }), 'ok');
  assert.equal(n, 3);
  assert.deepEqual(seen[0].slice(0, 4), ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false']);
  assert.ok(seen[0].includes('fetch'));
});
test('gives up after 3 attempts and rethrows', () => {
  let n = 0;
  const run = () => { n++; throw new Error('shallow file has changed since we read it'); };
  assert.throws(() => retryFetch(['x'], {}, { run, sleep: noSleep }), /shallow file has changed/);
  assert.equal(n, 3);
});
test('does not retry a permanent error', () => {
  let n = 0;
  const run = () => { n++; throw new Error("fatal: couldn't find remote ref refs/heads/nope"); };
  assert.throws(() => retryFetch(['x'], {}, { run, sleep: noSleep }));
  assert.equal(n, 1);
});
test('transient classifier', () => {
  assert.ok(isTransientGitError('error: RPC failed; HTTP 503'));
  assert.ok(!isTransientGitError('CONFLICT in file'));
});
