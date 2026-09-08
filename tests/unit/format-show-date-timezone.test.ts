/**
 * BRO-3047: bare "YYYY-MM-DD" show dates (openingDate/closingDate/
 * previewsStartDate) parse as UTC midnight. Formatting with
 * .toLocaleDateString() and no timeZone override shifts to the runtime's
 * local timezone, rendering one day early for every US timezone. This locks
 * formatShowDate to always render the stored calendar date regardless of the
 * process timezone.
 *
 * Calls the real exported function (CLAUDE.md rule 15).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatShowDate } from '../../src/lib/date-utils';

test('renders the stored calendar date under process.env.TZ = America/Los_Angeles', () => {
  const original = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    assert.equal(formatShowDate('2026-07-26'), 'Jul 26, 2026');
    assert.equal(formatShowDate('2026-01-01'), 'Jan 1, 2026');
  } finally {
    process.env.TZ = original;
  }
});

test('renders the stored calendar date under process.env.TZ = UTC', () => {
  const original = process.env.TZ;
  process.env.TZ = 'UTC';
  try {
    assert.equal(formatShowDate('2026-07-26'), 'Jul 26, 2026');
  } finally {
    process.env.TZ = original;
  }
});

test('supports month/year granularity', () => {
  assert.equal(formatShowDate('2026-07-26', { month: 'short', year: 'numeric' }), 'Jul 2026');
  assert.equal(formatShowDate('2026-07-26', { month: 'long', year: 'numeric' }), 'July 2026');
  assert.equal(formatShowDate('2026-07-26', { month: 'long' }), 'July');
});

test('supports long month/day/year granularity', () => {
  assert.equal(formatShowDate('2026-07-26', { month: 'long', day: 'numeric', year: 'numeric' }), 'July 26, 2026');
});

test('missing or invalid dates format to empty string', () => {
  for (const missing of [null, undefined, '', 'not-a-date']) {
    assert.equal(formatShowDate(missing as string | null | undefined), '');
  }
});

test('a field that unexpectedly carries a full timestamp-with-offset does not shift the calendar date', () => {
  // Ship-check (Codex adversarial review) flagged that naive `new Date(dateStr)`
  // parsing lets an embedded time+offset shift the rendered day depending on
  // the offset — exactly the class of bug this helper exists to prevent, just
  // triggered by unexpected input shape instead of the missing timeZone
  // override. Only the first 10 chars (the date part) are ever parsed.
  assert.equal(formatShowDate('2026-07-26T23:00:00-04:00'), 'Jul 26, 2026');
  assert.equal(formatShowDate('2026-07-26T00:00:00+01:00'), 'Jul 26, 2026');
  assert.equal(formatShowDate('2026-07-26T12:00:00Z'), 'Jul 26, 2026');
});
