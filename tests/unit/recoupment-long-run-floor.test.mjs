// BRO-6720: venue floor for long-running musicals and the closed-show credit floor.
// All numbers are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { venueSizeFactor, LONG_RUN_WEEKS } = require('../../scripts/lib/recoupment-model.js');
const { closedCreditFloor, isClosedShow } = require('../../scripts/lib/model-run-fields.js');

const NOW = Date.parse('2026-06-01');
const small = { venue: 'Hudson Theatre', openingDate: '2019-04-01', closingDate: null };

test('a long modern musical in a small house is not shrunk below 1', () => {
  const short = venueSizeFactor({ ...small, openingDate: '2026-01-01' }, 'musical', { now: NOW });
  const long = venueSizeFactor(small, 'musical', { now: NOW });
  assert.ok(short <= long);
  assert.equal(long, 1);
});

test('the floor can be switched off, and does not touch plays or old runs', () => {
  const off = venueSizeFactor(small, 'musical', { now: NOW, longRunVenueFloor: false });
  assert.ok(off <= 1);
  assert.equal(venueSizeFactor(small, 'play', { now: NOW }) <= 1.2, true);
  const old = venueSizeFactor({ ...small, openingDate: '2009-04-01' }, 'musical', { now: NOW });
  assert.equal(old, off);
  assert.equal(LONG_RUN_WEEKS, 78);
});

test('a closed run is measured to its closing date', () => {
  const closed = { ...small, openingDate: '2024-01-01', closingDate: '2024-06-01' };
  assert.ok(venueSizeFactor(closed, 'musical', { now: NOW }) <= 1);
});

test('closed credit floor raises the centre and high, never the low', () => {
  assert.deepEqual(closedCreditFloor([0, 0, 0], 20), [0, 15, 20]);
  assert.deepEqual(closedCreditFloor([0, 40, 60], 20), [0, 40, 60]);
  assert.deepEqual(closedCreditFloor([0, 0, 0], 0), [0, 0, 0]);
  assert.equal(closedCreditFloor(null, 20), null);
});

test('isClosedShow reads status or a past closing date', () => {
  assert.equal(isClosedShow({ status: 'closed' }, {}, NOW), true);
  assert.equal(isClosedShow({ status: 'open', closingDate: '2030-01-01' }, {}, NOW), false);
  assert.equal(isClosedShow({ status: 'open', closingDate: '2020-01-01' }, {}, NOW), false);
  assert.equal(isClosedShow({ closingDate: '2020-01-01' }, {}, NOW), true);
});

test('applyReturnedSoFarFields applies the credit floor only for a closed show', () => {
  const { applyReturnedSoFarFields } = require('../../scripts/lib/model-run-fields.js');
  const returned = { recoupmentPctLow: 0, recoupmentPctCentral: 0, recoupmentPctHigh: 0, taxCreditApplied: 2e6 };
  const closed = { capitalization: 10e6 };
  applyReturnedSoFarFields(closed, returned, { status: 'closed' });
  assert.deepEqual(closed.modelReturnedExCreditPct, [0, 15, 20]);
  const open = { capitalization: 10e6 };
  applyReturnedSoFarFields(open, returned, { status: 'open' });
  assert.deepEqual(open.modelReturnedExCreditPct, [0, 0, 0]);
  const noShow = { capitalization: 10e6 };
  applyReturnedSoFarFields(noShow, returned);
  assert.deepEqual(noShow.modelReturnedExCreditPct, [0, 0, 0]);
});

test('a replay as of an early date does not see a later long run', () => {
  const show = { venue: 'Hudson Theatre', openingDate: '2019-04-01', closingDate: null };
  const early = venueSizeFactor(show, 'musical', { now: NOW, asOf: '2019-08-01' });
  assert.ok(early < 1);
});

test('closedCreditFloor leaves a band with a NaN untouched', () => {
  const band = [0, NaN, 5];
  assert.equal(closedCreditFloor(band, 20), band);
});
