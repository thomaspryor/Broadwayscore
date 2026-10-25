// Tests for the possibly-closed routing in audit-closing-dates.js.
// Regression anchor: Celebrity Autobiography closed 2026-06-21, broadway.com
// removed its page, and the audit filed the title mismatch under silent
// `errors` for 3+ weeks while shows.json said open-through-9/6.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyMissingSchedule, possiblyClosedPressAgreement } = require('./closing-audit-classify.js');

const TODAY = '2026-07-14';
const MIN_DAYS = 5;

test('title_mismatch with far-future stored close → POSSIBLY_CLOSED (Celebrity Autobiography class)', () => {
  const v = classifyMissingSchedule({
    closingDate: '2026-09-06', todayStr: TODAY, minDays: MIN_DAYS,
    allowlisted: false, kind: 'title_mismatch',
  });
  assert.equal(v.action, 'POSSIBLY_CLOSED_NEEDS_REVIEW');
  assert.equal(v.daysUntilStored, 54);
  assert.equal(v.reason, 'title_mismatch');
});

test('empty_schedule with far-future stored close → POSSIBLY_CLOSED (Burnout Paradise class, pre-existing behavior)', () => {
  const v = classifyMissingSchedule({
    closingDate: '2026-08-30', todayStr: TODAY, minDays: MIN_DAYS,
    allowlisted: false, kind: 'empty_schedule',
  });
  assert.equal(v.action, 'POSSIBLY_CLOSED_NEEDS_REVIEW');
  assert.equal(v.reason, 'empty_schedule');
});

test('title_mismatch with no stored closingDate → silent error (open-run show, likely slug collision)', () => {
  const v = classifyMissingSchedule({
    closingDate: null, todayStr: TODAY, minDays: MIN_DAYS,
    allowlisted: false, kind: 'title_mismatch',
  });
  assert.equal(v.action, 'ERROR');
  assert.equal(v.reason, 'broadway_com_title_mismatch');
});

test('allowlisted show short-circuits to error even with far-future stored close', () => {
  const v = classifyMissingSchedule({
    closingDate: '2026-09-06', todayStr: TODAY, minDays: MIN_DAYS,
    allowlisted: true, kind: 'title_mismatch',
  });
  assert.equal(v.action, 'ERROR');
});

test('stored close within minDays window → error (final-days calendars legitimately go empty)', () => {
  const v = classifyMissingSchedule({
    closingDate: '2026-07-17', todayStr: TODAY, minDays: MIN_DAYS,
    allowlisted: false, kind: 'empty_schedule',
  });
  assert.equal(v.action, 'ERROR');
  assert.equal(v.reason, 'no_future_dates_on_schedule');
});

test('stored close already past → error, not possibly-closed', () => {
  const v = classifyMissingSchedule({
    closingDate: '2026-06-21', todayStr: TODAY, minDays: MIN_DAYS,
    allowlisted: false, kind: 'title_mismatch',
  });
  assert.equal(v.action, 'ERROR');
});

test('press agreement: press date earlier than stored → auto-apply (Celebrity: press 6/21 vs stored 9/6)', () => {
  assert.equal(possiblyClosedPressAgreement('2026-09-06', '2026-06-21'), true);
});

test('press agreement: press date equal to stored → no auto-apply (nothing to fix)', () => {
  assert.equal(possiblyClosedPressAgreement('2026-09-06', '2026-09-06'), false);
});

test('press agreement: press date after stored → no auto-apply (contradicts possibly-closed hypothesis)', () => {
  assert.equal(possiblyClosedPressAgreement('2026-09-06', '2026-10-04'), false);
});

test('press agreement: missing or invalid dates → no auto-apply', () => {
  assert.equal(possiblyClosedPressAgreement(null, '2026-06-21'), false);
  assert.equal(possiblyClosedPressAgreement('2026-09-06', null), false);
  assert.equal(possiblyClosedPressAgreement('not-a-date', '2026-06-21'), false);
});

test('press agreement, title_mismatch: past press date → auto-apply (removed page = show already closed)', () => {
  assert.equal(possiblyClosedPressAgreement('2026-09-06', '2026-06-21', { kind: 'title_mismatch', todayStr: TODAY }), true);
});

test('press agreement, title_mismatch: FUTURE press date → no auto-apply (could be slug collision on a running show)', () => {
  assert.equal(possiblyClosedPressAgreement('2026-10-04', '2026-08-02', { kind: 'title_mismatch', todayStr: TODAY }), false);
});

test('press agreement, title_mismatch: press date = today → auto-apply (closing tonight, page already pulled)', () => {
  assert.equal(possiblyClosedPressAgreement('2026-09-06', TODAY, { kind: 'title_mismatch', todayStr: TODAY }), true);
});

test('press agreement, title_mismatch without todayStr → no auto-apply (fail closed)', () => {
  assert.equal(possiblyClosedPressAgreement('2026-09-06', '2026-06-21', { kind: 'title_mismatch' }), false);
});

test('press agreement, empty_schedule: future press date earlier than stored still auto-applies (title confirmed on page)', () => {
  assert.equal(possiblyClosedPressAgreement('2026-10-04', '2026-08-02', { kind: 'empty_schedule', todayStr: TODAY }), true);
});

test('empty_schedule with NO stored closingDate → POSSIBLY_CLOSED (The Balusters class: limited run, no close ever stored)', () => {
  const v = classifyMissingSchedule({
    closingDate: null, todayStr: TODAY, minDays: MIN_DAYS,
    allowlisted: false, kind: 'empty_schedule',
  });
  assert.equal(v.action, 'POSSIBLY_CLOSED_NEEDS_REVIEW');
  assert.equal(v.daysUntilStored, null);
});

test('press agreement, no stored close: past press date → auto-apply (Balusters: press 6/21, no stored close)', () => {
  assert.equal(possiblyClosedPressAgreement(null, '2026-06-21', { kind: 'empty_schedule', todayStr: TODAY }), true);
});

test('press agreement, no stored close: FUTURE press date → no auto-apply (calendar gap on a running show)', () => {
  assert.equal(possiblyClosedPressAgreement(null, '2026-08-02', { kind: 'empty_schedule', todayStr: TODAY }), false);
});
