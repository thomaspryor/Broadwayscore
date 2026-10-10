import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DEFAULT_GIVEUP_THRESHOLD, isOutletGivenUp, updateOutletMisses } = require('./js-outlet-giveup.js');

// BRO-2941: opening-night-poller.js re-rendered every still-missing requiresJs
// outlet on every tick forever. These are the pure counter functions the poller
// now uses to suppress a (show, outlet) pair after repeated misses.

test('isOutletGivenUp is false below threshold, true at/above it', () => {
  assert.equal(isOutletGivenUp({ telegraph: DEFAULT_GIVEUP_THRESHOLD - 1 }, 'telegraph'), false);
  assert.equal(isOutletGivenUp({ telegraph: DEFAULT_GIVEUP_THRESHOLD }, 'telegraph'), true);
  assert.equal(isOutletGivenUp({ telegraph: DEFAULT_GIVEUP_THRESHOLD + 5 }, 'telegraph'), true);
});

test('isOutletGivenUp defaults to false for an outlet never attempted', () => {
  assert.equal(isOutletGivenUp({}, 'vulture'), false);
  assert.equal(isOutletGivenUp(null, 'vulture'), false);
});

test('updateOutletMisses increments outlets attempted-but-not-found', () => {
  const next = updateOutletMisses({ vulture: 3 }, ['vulture', 'telegraph'], new Set());
  assert.equal(next.vulture, 4);
  assert.equal(next.telegraph, 1);
});

test('updateOutletMisses resets (deletes) an outlet found this tick', () => {
  const next = updateOutletMisses({ vulture: 9, telegraph: 2 }, ['vulture', 'telegraph'], new Set(['vulture']));
  assert.equal(next.vulture, undefined, 'found outlet must reset, not just decrement');
  assert.equal(next.telegraph, 3);
});

test('repeated misses cross the give-up threshold, then a find resets it', () => {
  let misses = {};
  for (let i = 0; i < DEFAULT_GIVEUP_THRESHOLD; i++) {
    misses = updateOutletMisses(misses, ['hollywood-reporter'], new Set());
  }
  assert.equal(isOutletGivenUp(misses, 'hollywood-reporter'), true, `after ${DEFAULT_GIVEUP_THRESHOLD} misses should be given up`);

  misses = updateOutletMisses(misses, ['hollywood-reporter'], new Set(['hollywood-reporter']));
  assert.equal(isOutletGivenUp(misses, 'hollywood-reporter'), false, 'a find must clear give-up state');
});

test('updateOutletMisses does not mutate the input map', () => {
  const original = { vulture: 3 };
  updateOutletMisses(original, ['vulture'], new Set());
  assert.deepEqual(original, { vulture: 3 });
});
