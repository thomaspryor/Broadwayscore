/**
 * BRO-7251: schedule / TodayTix evidence alone must never write a closingDate.
 * Requires the real decision functions from scripts/lib (no copied logic).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { classifyScheduleEvidence, isTodayTixBookingHorizon } = require('../../scripts/lib/closing-date-evidence.js');
const { writeClosingDate } = require('../../scripts/lib/closing-date-guard.js');

// Mirrors the audit's use: a write happens only if the classifier says write.
function auditApply(show, latest) {
  const c = classifyScheduleEvidence(show.closingDate, latest);
  if (c.write) writeClosingDate(show, latest, 'broadway.com schedule', { log: () => {} });
  return c;
}

describe('closing-date evidence (BRO-7251)', () => {
  test('schedule-only extension to the booking horizon does not write', () => {
    const show = { id: 'x', closingDate: '2026-12-01' };
    const c = auditApply(show, '2027-04-15');
    assert.equal(show.closingDate, '2026-12-01');
    assert.equal(c.action, 'EXTENSION_SCHEDULE_ONLY_NEEDS_REVIEW');
  });
  test('open-ended run (no stored date) is flagged, not assigned', () => {
    const show = { id: 'x', closingDate: null };
    const c = auditApply(show, '2027-04-15');
    assert.equal(show.closingDate, null);
    assert.equal(c.action, 'NEW_CLOSING_NEEDS_REVIEW');
  });
  test('jump over the cap is review-only', () => {
    const c = classifyScheduleEvidence('2026-12-01', '2027-12-01');
    assert.equal(c.action, 'EXTENSION_EXCEEDS_CAP_NEEDS_REVIEW');
    assert.equal(c.write, false);
  });
  test('no classification ever returns write=true', () => {
    for (const [s, l] of [[null, '2027-01-01'], ['2026-12-01', '2027-01-01'], ['2027-06-01', '2027-01-01'], ['2027-01-01', '2027-01-01'], ['2026-12-01', null]]) {
      assert.equal(classifyScheduleEvidence(s, l).write, false);
    }
  });
  test('TodayTix: far date shared by 3+ shows is a booking horizon', () => {
    const feed = ['2027-04-15', '2027-04-15', '2027-04-15', '2026-11-29'];
    assert.equal(isTodayTixBookingHorizon('2027-04-15', feed, '2026-11-09'), true);
  });
  test('TodayTix: near or unshared real closings are kept', () => {
    const feed = ['2027-04-15', '2027-04-15', '2027-04-15', '2026-11-29', '2027-01-17'];
    assert.equal(isTodayTixBookingHorizon('2026-11-29', feed, '2026-11-09'), false);
    assert.equal(isTodayTixBookingHorizon('2027-01-17', feed, '2026-11-09'), false);
    assert.equal(isTodayTixBookingHorizon(null, feed, '2026-11-09'), false);
  });

  test('audit script source has no schedule-only closingDate write', () => {
    const src = readFileSync(new URL('../../scripts/audit-closing-dates.js', import.meta.url), 'utf8');
    assert.ok(!/writeClosingDate\([^)]*broadway\.com schedule/.test(src), 'schedule-only writeClosingDate came back');
    assert.ok(src.includes("require('./lib/closing-date-evidence')"));
  });
});
