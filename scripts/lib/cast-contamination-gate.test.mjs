import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shouldBlockCastContaminationGate, GATE_SIGNALS } = require('./cast-contamination-gate.js');

test('passes when no wrong-show cast contamination (floor 0, the steady state)', () => {
  assert.equal(shouldBlockCastContaminationGate({ gateHits: 0 }), false);
});

test('blocks on ANY wrong-show cast file (floor 0 — the 2026-05-23 opera-singer class)', () => {
  assert.equal(shouldBlockCastContaminationGate({ gateHits: 1 }), true);
  assert.equal(shouldBlockCastContaminationGate({ gateHits: 12 }), true);
});

test('floor is configurable (a triaged baseline could be absorbed)', () => {
  assert.equal(shouldBlockCastContaminationGate({ gateHits: 2, floor: 2 }), false, 'at floor is not over floor');
  assert.equal(shouldBlockCastContaminationGate({ gateHits: 3, floor: 2 }), true);
});

test('GATE_SIGNALS is the zero-FP wrong-show subset, excludes the soft heuristics', () => {
  for (const s of ['OPERA_ROLES', 'TV_ROLES', 'NAME_SWAP', 'ROLE_IS_COLUMN_HEADER', 'SRC_URL_OPERA_DOMAIN']) {
    assert.ok(GATE_SIGNALS.has(s), `${s} should gate`);
  }
  // SRC_URL_NO_TITLE (URL-token heuristic) and SHOW_NOT_IN_DB (show-add timing)
  // are warn-only — they must NOT block the trunk.
  assert.ok(!GATE_SIGNALS.has('SRC_URL_NO_TITLE'));
  assert.ok(!GATE_SIGNALS.has('SHOW_NOT_IN_DB'));
});
