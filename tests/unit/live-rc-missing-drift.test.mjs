// Task #242 / Linear BRO-8: a live show JSON served with HTTP 200 but no
// numeric `rc` field is a REAL drift signal (the deployed artifact is
// malformed/stale), not a "can't compare" skip. These tests require() the
// real classifier — never a copy (CLAUDE.md rule 15).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyLiveRcPayload, isLiveRcMissingField } = require('../../scripts/lib/review-count-probe.js');

test('numeric rc classifies as clean', () => {
  const r = classifyLiveRcPayload({ rc: 7, rv: [] });
  assert.equal(r.rc, 7);
  assert.equal(r.err, null);
  assert.equal(r.errKind, null);
  assert.equal(isLiveRcMissingField(r), false);
});

test('rc absent classifies as missing-field drift signal', () => {
  const r = classifyLiveRcPayload({ title: 'Some Show', rv: [] });
  assert.equal(r.rc, null);
  assert.equal(r.errKind, 'missing-field');
  assert.equal(isLiveRcMissingField(r), true);
});

test('rc of wrong type (string) classifies as missing-field', () => {
  const r = classifyLiveRcPayload({ rc: '7' });
  assert.equal(r.rc, null);
  assert.equal(r.errKind, 'missing-field');
  assert.equal(isLiveRcMissingField(r), true);
});

test('null/empty payload classifies as missing-field, not a crash', () => {
  assert.equal(classifyLiveRcPayload(null).errKind, 'missing-field');
  assert.equal(classifyLiveRcPayload({}).errKind, 'missing-field');
});

test('transport-style errors are NOT missing-field', () => {
  assert.equal(isLiveRcMissingField({ rc: null, err: 'HTTP 404', errKind: 'http' }), false);
  assert.equal(isLiveRcMissingField({ rc: null, err: 'timeout (8s)', errKind: 'timeout' }), false);
  assert.equal(isLiveRcMissingField(null), false);
});
