/**
 * check-corpus-drift — exit policy + verdict assembly.
 *
 * This monitor's whole reason to exist is that DRIFT MUST NOT FAIL THE JOB
 * (drift surfaces in the digest; a failing job would reintroduce the exact
 * trunk-reddening this split removes). Only a crashed audit, or drift under
 * --strict, may escalate. These tests lock that policy so a future edit can't
 * silently turn the monitor back into a blocking gate.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildVerdict, decideExit } = require('../../scripts/check-corpus-drift.js');

const ok = (name) => ({ name, ok: true, crashed: false, exitCode: 0 });
const drift = (name) => ({ name, ok: false, crashed: false, exitCode: 1 });
const crashed = (name) => ({ name, ok: false, crashed: true, exitCode: 2 });

describe('check-corpus-drift exit policy', () => {
  test('all audits ok → exit 0', () => {
    const v = buildVerdict([ok('a'), ok('b')], 'T');
    assert.equal(decideExit({ ...v.summary, strict: false }), 0);
  });

  test('drift WITHOUT --strict → exit 0 (passive monitor, surfaces in digest)', () => {
    const v = buildVerdict([ok('a'), drift('b')], 'T');
    assert.equal(v.summary.anyDrift, true);
    assert.equal(decideExit({ ...v.summary, strict: false }), 0);
  });

  test('drift WITH --strict → exit 2', () => {
    const v = buildVerdict([drift('b')], 'T');
    assert.equal(decideExit({ ...v.summary, strict: true }), 2);
  });

  test('a crashed audit → exit 3 even without --strict (real error, not drift)', () => {
    const v = buildVerdict([ok('a'), crashed('b')], 'T');
    assert.equal(v.summary.anyCrashed, true);
    assert.equal(decideExit({ ...v.summary, strict: false }), 3);
  });

  test('crash takes precedence over drift+strict (3 not 2)', () => {
    const v = buildVerdict([drift('a'), crashed('b')], 'T');
    assert.equal(decideExit({ ...v.summary, strict: true }), 3);
  });
});

describe('check-corpus-drift verdict shape', () => {
  test('summary counts drift and crash separately', () => {
    const v = buildVerdict([ok('a'), drift('b'), crashed('c')], '2026-06-22T00:00:00Z');
    assert.equal(v.summary.auditsRun, 3);
    assert.equal(v.summary.driftCount, 1);
    assert.equal(v.summary.crashCount, 1);
    assert.equal(v._meta.generatedAt, '2026-06-22T00:00:00Z');
    assert.equal(v.audits.length, 3);
  });
});
