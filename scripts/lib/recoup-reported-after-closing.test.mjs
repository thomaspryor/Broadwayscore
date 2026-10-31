// The shared rule behind "Reported after closing" on /biz and in the newsletter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { recoupReportedAfterClosing, newsletterWeeksToRecoup } = createRequire(import.meta.url)('./recoup-reported-after-closing');

test('report month after the closing month is true (Purpose, Kimberly Akimbo)', () => {
  assert.equal(recoupReportedAfterClosing('2026-06', '2025-08-31'), true);
  assert.equal(recoupReportedAfterClosing('2026-04', '2024-04-28'), true);
});
test('same or earlier month, year-only, missing or malformed is false', () => {
  assert.equal(recoupReportedAfterClosing('2024-04', '2024-04-28'), false);
  assert.equal(recoupReportedAfterClosing('2024-03', '2024-04-28'), false);
  assert.equal(recoupReportedAfterClosing('2026', '2025-08-31'), false);
  assert.equal(recoupReportedAfterClosing('2026-13', '2025-08-31'), false);
  assert.equal(recoupReportedAfterClosing('2026-06', null), false);
  assert.equal(recoupReportedAfterClosing(null, '2025-08-31'), false);
});
test('a show closing on the 1st does not depend on the timezone', () => {
  const prev = process.env.TZ;
  try {
    for (const tz of ['America/New_York', 'UTC', 'Pacific/Kiritimati']) {
      process.env.TZ = tz;
      assert.equal(recoupReportedAfterClosing('2024-05', '2024-05-01'), false, tz);
      assert.equal(recoupReportedAfterClosing('2024-06', '2024-05-01'), true, tz);
    }
  } finally {
    if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev;
  }
});

// The newsletter used to count opening night to the 15th of the report month with
// no closing check, so Purpose (24-week run, reported Jun 2026) read "in 65 weeks".
test('newsletter weeks: Purpose and Kimberly Akimbo (reported after closing) get none', () => {
  assert.equal(newsletterWeeksToRecoup('2025-03-17', '2026-06', '2025-08-31'), null);
  assert.equal(newsletterWeeksToRecoup('2022-11-10', '2026-04', '2024-04-28'), null);
});
test('newsletter weeks: unchanged for a show reported inside its run or still open', () => {
  assert.equal(newsletterWeeksToRecoup('2024-03-10', '2024-09', null), 27);
  assert.equal(newsletterWeeksToRecoup('2025-03-17', '2025-06', '2025-08-31'), 13);
});
test('newsletter weeks: missing, year-only or non-positive is null', () => {
  assert.equal(newsletterWeeksToRecoup(null, '2024-09', null), null);
  assert.equal(newsletterWeeksToRecoup('2024-03-10', '2024', null), null);
  assert.equal(newsletterWeeksToRecoup('2024-09-30', '2024-03', null), null);
});

test('newsletter weeks: an estimated recoupment date is never counted (Chicago "March 1997")', () => {
  assert.equal(newsletterWeeksToRecoup('1996-11-14', '1997-03', null, true), null);
  assert.equal(newsletterWeeksToRecoup('1996-11-14', '1997-03', null, false), 17);
});
