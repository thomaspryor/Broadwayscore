import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shouldBlockDuplicateOfGate } = require('./duplicate-of-gate.js');

const FLOOR = 25; // = FIX_SURGE_THRESHOLD in audit-duplicate-of-url-mismatch.js

test('passes when mismatch count is at or under the surge floor (routine auto-healable churn)', () => {
  // The 4-BWW sinatra case that flapped the trunk: well under the floor, --fix heals it.
  assert.equal(shouldBlockDuplicateOfGate({ mismatchCount: 4, floor: FLOOR }), false);
  assert.equal(shouldBlockDuplicateOfGate({ mismatchCount: 0, floor: FLOOR }), false);
  assert.equal(shouldBlockDuplicateOfGate({ mismatchCount: 1, floor: FLOOR }), false);
  assert.equal(shouldBlockDuplicateOfGate({ mismatchCount: FLOOR, floor: FLOOR }), false, 'at floor is not over floor');
});

test('blocks on a mass spike past the floor (producer regression — auto-clearing would flood scoring)', () => {
  assert.equal(shouldBlockDuplicateOfGate({ mismatchCount: FLOOR + 1, floor: FLOOR }), true);
  assert.equal(shouldBlockDuplicateOfGate({ mismatchCount: 200, floor: FLOOR }), true);
});
