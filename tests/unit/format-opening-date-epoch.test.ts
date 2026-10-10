/**
 * Locks formatOpeningDate against the epoch bug.
 *
 * `new Date(null)` and `new Date(undefined)` are not errors in JS — the first
 * is 1970-01-01, the second is Invalid Date. The unguarded formatter turned a
 * missing openingDate into the string "Jan 1970", which shipped to users as
 * "Opens Jan 1970" on six live shows (owner, 2026-08-13) and, through the same
 * arithmetic in scrape-tony-awards.js, wrote eight fabricated "shut out at the
 * 1970 Tonys" records into awards.json.
 *
 * Calls the real exported function (CLAUDE.md rule 15).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatOpeningDate } from '../../src/lib/date-utils';

test('missing dates format to empty string, never to the epoch', () => {
  for (const missing of [null, undefined, '']) {
    const out = formatOpeningDate(missing as string | null | undefined);
    assert.equal(out, '', `expected '' for ${JSON.stringify(missing)}, got ${JSON.stringify(out)}`);
    assert.doesNotMatch(out, /1970/, 'must never render the epoch year');
  }
});

test('unparseable dates format to empty string rather than "NaN NaN"', () => {
  for (const junk of ['TBA', 'not-a-date', '']) {
    assert.equal(formatOpeningDate(junk), '');
  }
  // NOT asserted: V8's date parser is lenient enough that 'Fall 2027' yields
  // 2027-01-01, so this formatter renders it "Jan 2027". That is a separate
  // (much smaller) issue than the epoch bug — every caller passes an ISO date
  // straight from shows.json — and this guard deliberately does not try to
  // become a date-format validator.
});

test('real dates still format as Mon YYYY in UTC', () => {
  assert.equal(formatOpeningDate('2026-08-25'), 'Aug 2026');
  assert.equal(formatOpeningDate('2027-01-07'), 'Jan 2027');
  // Jan 1 must survive: it is a legitimate opening date, and a naive
  // "does the output say January?" guard would wrongly suppress it.
  assert.equal(formatOpeningDate('2027-01-01'), 'Jan 2027');
});

test('a genuine 1970 opening date is still rendered', () => {
  // The guard keys off presence/validity, not off the year — suppressing 1970
  // outright would corrupt the historical corpus.
  assert.equal(formatOpeningDate('1970-04-26'), 'Apr 1970');
});
