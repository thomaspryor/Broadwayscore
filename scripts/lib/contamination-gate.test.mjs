import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shouldBlockContaminationGate } = require('./contamination-gate.js');

const FLOOR = 25;

test('passes when no cross-market leak and strict hits at/under floor', () => {
  // The china-doll FT/Guardian case that flapped the trunk: 1 strict hit, 0 A.
  assert.equal(shouldBlockContaminationGate({ crossMarketLeaks: 0, strictHits: 1, floor: FLOOR }), false);
  assert.equal(shouldBlockContaminationGate({ crossMarketLeaks: 0, strictHits: 0, floor: FLOOR }), false);
  assert.equal(shouldBlockContaminationGate({ crossMarketLeaks: 0, strictHits: FLOOR, floor: FLOOR }), false, 'at floor is not over floor');
});

test('blocks on ANY cross-market leak (class A is zero-tolerance), even under the floor', () => {
  assert.equal(shouldBlockContaminationGate({ crossMarketLeaks: 1, strictHits: 1, floor: FLOOR }), true);
  assert.equal(shouldBlockContaminationGate({ crossMarketLeaks: 1, strictHits: 0, floor: FLOOR }), true);
});

test('blocks on a mass-contamination spike past the floor (the original 291-hit class)', () => {
  assert.equal(shouldBlockContaminationGate({ crossMarketLeaks: 0, strictHits: FLOOR + 1, floor: FLOOR }), true);
  assert.equal(shouldBlockContaminationGate({ crossMarketLeaks: 0, strictHits: 291, floor: FLOOR }), true);
});
