import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shouldBlockCommercialContaminationGate } = require('./commercial-contamination-gate.js');

test('passes with no impossible-physics records (floor 0, the steady state)', () => {
  assert.equal(shouldBlockCommercialContaminationGate({ gateHits: 0 }), false);
});

test('blocks on ANY FAIL record (weekly>cap, recouped contradiction, cap/weekly outlier)', () => {
  assert.equal(shouldBlockCommercialContaminationGate({ gateHits: 1 }), true);
  assert.equal(shouldBlockCommercialContaminationGate({ gateHits: 5 }), true);
});

test('warns do NOT reach this gate — only FAIL hits are passed in as gateHits', () => {
  // A forthcoming show (SHOW_NOT_IN_DB) or category mismatch is warn-only; the
  // caller filters those out, so gateHits stays 0 and the trunk passes.
  assert.equal(shouldBlockCommercialContaminationGate({ gateHits: 0, floor: 0 }), false);
});

test('floor is configurable', () => {
  assert.equal(shouldBlockCommercialContaminationGate({ gateHits: 1, floor: 1 }), false);
  assert.equal(shouldBlockCommercialContaminationGate({ gateHits: 2, floor: 1 }), true);
});
