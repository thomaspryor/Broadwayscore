import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseMaxArg, MaxArgError } = require('./parse-max-arg.js');

// The hole this replaces: `parseInt('abc', 10)` is NaN, and every gate script
// compares `hits.length > max`, so `> NaN` is ALWAYS false — a typo'd ceiling
// silently turned a blocking gate into a no-op that still printed a pass.
// test.yml runs audit-self-contradictory-clears.js at --max=780.

test('valid non-negative integers parse', () => {
  assert.equal(parseMaxArg(['--max=0']), 0);
  assert.equal(parseMaxArg(['--max=15']), 15);
  assert.equal(parseMaxArg(['--max=780']), 780);
  assert.equal(parseMaxArg(['--max=007']), 7);
  assert.equal(parseMaxArg(['--gate', '--max=3', '--json']), 3);
});

test('absent --max yields the caller-supplied default', () => {
  assert.equal(parseMaxArg(['--gate']), 0);
  assert.equal(parseMaxArg(['--gate'], { defaultMax: 5 }), 5);
  assert.equal(parseMaxArg([], { defaultMax: 15 }), 15);
});

test('every value that used to become NaN is now rejected', () => {
  for (const bad of ['--max=abc', '--max=', '--max=1.5', '--max=-1', '--max=15x', '--max=NaN', '--max= 3']) {
    assert.throws(() => parseMaxArg([bad]), MaxArgError, `${bad} must be rejected`);
  }
});

test('the NaN comparison this prevents really is always false (regression rationale)', () => {
  // Documents WHY rejection matters rather than defaulting: if we coerced to
  // NaN, a gate with 121 hits would report a pass.
  assert.equal(121 > Number.NaN, false);
  assert.equal(0 > Number.NaN, false);
});

test('a bare --max (no "=") is rejected rather than silently using the default', () => {
  // The old `startsWith('--max=')` check never matched a bare `--max`, so an
  // operator who wrote `--max 15` got the default ceiling with no warning.
  assert.throws(() => parseMaxArg(['--gate', '--max', '15']), MaxArgError);
});

test('the error message names the script so a CI log points at the right gate', () => {
  try {
    parseMaxArg(['--max=abc'], { scriptName: 'audit-self-contradictory-clears' });
    assert.fail('should have thrown');
  } catch (e) {
    assert.match(e.message, /audit-self-contradictory-clears/);
    assert.match(e.message, /non-negative integer/);
  }
});
