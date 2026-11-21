/**
 * BRO-7890 item 5: month-only publishDates ("2016-03", 163 rows) rendered as "Mar 1, 2016" on the show page,
 * inventing a day. Calls the real exported formatter (CLAUDE.md rule 15).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatReviewDate } from '../../src/lib/date-utils';

test('day, month and year precision render at their own precision', () => {
  assert.equal(formatReviewDate('2016-03-05'), 'Mar 5, 2016');
  assert.equal(formatReviewDate('2016-03'), 'Mar 2016');
  assert.equal(formatReviewDate('2016'), '2016');
});

test('a UTC timestamp renders as the New York day (lane rows like 2026-11-18T02:00:00.000Z)', () => {
  assert.equal(formatReviewDate('2026-11-18T02:00:00.000Z'), 'Nov 17, 2026');
  assert.equal(formatReviewDate('2026-11-18T15:00:00-05:00'), 'Nov 18, 2026');
});

test('day precision never shifts with the process timezone', () => {
  const old = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try { assert.equal(formatReviewDate('2016-03-05'), 'Mar 5, 2016'); } finally { process.env.TZ = old; }
});

test('missing, invalid or epoch-style values hide instead of printing garbage', () => {
  for (const v of [null, undefined, '', 'not a date', '2016-13', '2016-02-30', '1970-01-01']) {
    assert.equal(formatReviewDate(v as string), '', String(v));
  }
});

test('ordinal text dates still parse', () => {
  assert.equal(formatReviewDate('March 5th, 2016'), 'Mar 5, 2016');
});
