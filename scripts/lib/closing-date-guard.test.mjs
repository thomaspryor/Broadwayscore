import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseRunMinutes, formatRuntime, computeTmFill, applyTmFill } = require('./tm-ob-fill.js');
const { writeClosingDate } = require('./closing-date-guard.js');

const TODAY = '2026-10-15';
const ob = (o = {}) => ({ id: 'x', category: 'off-broadway', status: 'open', openingDate: '2026-09-01', closingDate: null, runtime: null, ...o });
const tm = (o = {}) => ({ closingDate: '2026-11-07', runtimeMinutes: 80, ...o });

test('closingDate is written for a null closingDate, source theatermania', () => {
  const s = ob();
  const w = applyTmFill(s, tm(), { today: TODAY, log() {} });
  assert.equal(s.closingDate, '2026-11-07');
  assert.equal(s.closingDateSource, 'theatermania');
  assert.equal(s.closingDateUpdatedAt, TODAY);
  assert.equal(w.closingDate, '2026-11-07');
});

test('humanCorrectedClosingDate is respected', () => {
  const s = ob({ humanCorrectedClosingDate: true });
  const w = applyTmFill(s, tm(), { today: TODAY, log() {} });
  assert.equal(s.closingDate, null);
  assert.equal(w.closingDate, undefined);
});

test('an existing closingDate or runtime is never overwritten', () => {
  const s = ob({ closingDate: '2026-12-01', runtime: '2h' });
  assert.deepEqual(computeTmFill(s, tm(), TODAY), {});
});

test('runtime is filled only when null, from run_duration minutes', () => {
  const s = ob();
  applyTmFill(s, tm({ closingDate: null }), { today: TODAY, log() {} });
  assert.equal(s.runtime, '1h 20m');
  assert.equal(s.closingDate, null);
});

test('open-ended long-runner: TM has no closing date, nothing is modified', () => {
  const s = ob({ runtime: '1h 30m' });
  assert.deepEqual(computeTmFill(s, tm({ closingDate: null, runtimeMinutes: null }), TODAY), {});
  assert.equal(s.closingDate, null);
});

test('rejects a past, malformed, or pre-opening closing date', () => {
  assert.equal(computeTmFill(ob(), tm({ closingDate: '2026-10-01' }), TODAY).closingDate, undefined);
  assert.equal(computeTmFill(ob(), tm({ closingDate: 'Nov 7' }), TODAY).closingDate, undefined);
  assert.equal(computeTmFill(ob({ openingDate: '2026-12-01' }), tm({ closingDate: '2026-11-07' }), TODAY).closingDate, undefined);
});

test('only live off-broadway rows are touched', () => {
  assert.deepEqual(computeTmFill(ob({ status: 'closed' }), tm(), TODAY), {});
  assert.deepEqual(computeTmFill(ob({ category: 'broadway' }), tm(), TODAY), {});
  assert.deepEqual(computeTmFill(null, tm(), TODAY), {});
});

test('run_duration parsing', () => {
  assert.equal(parseRunMinutes(80), 80);
  assert.equal(parseRunMinutes('90'), 90);
  assert.equal(parseRunMinutes('90 minutes'), 90);
  assert.equal(parseRunMinutes('1h 30m'), 90);
  assert.equal(parseRunMinutes('2 hours'), 120);
  assert.equal(parseRunMinutes('2 hours 15 minutes'), 135);
  assert.equal(parseRunMinutes(''), null);
  assert.equal(parseRunMinutes(null), null);
  assert.equal(parseRunMinutes('5'), null);
  assert.equal(parseRunMinutes('9999'), null);
  assert.equal(parseRunMinutes('approx 90-100'), null);
  assert.equal(parseRunMinutes('2x45'), null);
  assert.equal(parseRunMinutes('90 mins (intermission)'), null);
  assert.equal(formatRuntime(45), '45m');
  assert.equal(formatRuntime(120), '2h');
});

test('writeClosingDate guard itself still blocks human-corrected shows', () => {
  const s = { id: 'h', closingDate: '2026-12-31', humanCorrectedClosingDate: true };
  assert.equal(writeClosingDate(s, '2026-11-01', 'x', { log() {} }), false);
  assert.equal(s.closingDate, '2026-12-31');
});

test('TM_FIELDS requests run_duration and a parsed row carries runtimeMinutes', () => {
  const { parseTmOffBroadwayRow } = require('./theatermania-ob.js');
  const src = require('node:fs').readFileSync(new URL('./theatermania-ob.js', import.meta.url), 'utf8');
  assert.match(src, /TM_FIELDS = '[^']*acf\.run_duration/);
  const venuesById = new Map([[1, { name: 'Westside Theatre', city: 'New York' }]]);
  const r = parseTmOffBroadwayRow({ title: { rendered: 'Test Show' }, link: 'x', id: 1, acf: { the_venue: 1, opening_date: '2026-09-01', closing_date: '2026-11-07', run_duration: '80' }, genre: [] }, { venuesById });
  if (r.candidate) assert.equal(r.candidate.runtimeMinutes, '80');
});
