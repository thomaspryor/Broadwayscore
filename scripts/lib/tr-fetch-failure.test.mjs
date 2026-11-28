import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { nextFetchFailureState: next, MAX_CONSECUTIVE_FETCH_FAILURES: F, MAX_CONSECUTIVE_MOVED: M } = createRequire(import.meta.url)('./tr-fetch-failure.js');

test('moved pages do not trip the plain cap but have their own cap', () => {
  let s = { consecutive: 0, moved: 0 };
  for (let i = 0; i < F + 1; i++) s = next(s, { failed: true, moved: true });
  assert.equal(s.abort, false);
  for (let i = F + 1; i < M; i++) s = next(s, { failed: true, moved: true });
  assert.equal(s.abort, true);
});
test('real failures trip at the plain cap', () => {
  let s = { consecutive: 0, moved: 0 };
  for (let i = 0; i < F; i++) s = next(s, { failed: true, moved: false });
  assert.equal(s.abort, true);
});
test('a success resets both counters', () => {
  const s = next({ consecutive: 7, moved: 20 }, { failed: false, moved: false });
  assert.deepEqual(s, { consecutive: 0, moved: 0, abort: false });
});
test('counters are since-last-success: mixed failures still hit the plain cap', () => {
  let s = { consecutive: 0, moved: 0 };
  for (let i = 0; i < F - 1; i++) s = next(s, { failed: true, moved: false });
  for (let i = 0; i < 5; i++) s = next(s, { failed: true, moved: true });
  assert.equal(s.abort, false);
  s = next(s, { failed: true, moved: false });
  assert.equal(s.abort, true);
});
