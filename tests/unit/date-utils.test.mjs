import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { normalizeDate, parseDate, stripOrdinals, validateCalendarDate } = require('../../scripts/lib/date-utils');

describe('stripOrdinals', () => {
  test('strips st suffix', () => assert.equal(stripOrdinals('March 1st, 2024'), 'March 1, 2024'));
  test('strips nd suffix', () => assert.equal(stripOrdinals('January 22nd, 2025'), 'January 22, 2025'));
  test('strips rd suffix', () => assert.equal(stripOrdinals('April 3rd, 2025'), 'April 3, 2025'));
  test('strips th suffix', () => assert.equal(stripOrdinals('February 11th, 2026'), 'February 11, 2026'));
  test('strips UK ordinals', () => assert.equal(stripOrdinals('22nd March 2025'), '22 March 2025'));
  test('no-op on clean dates', () => assert.equal(stripOrdinals('March 1, 2024'), 'March 1, 2024'));
});

describe('validateCalendarDate', () => {
  test('valid date', () => assert.equal(validateCalendarDate(2026, 2, 11), '2026-02-11'));
  test('pads single-digit month and day', () => assert.equal(validateCalendarDate(2024, 3, 1), '2024-03-01'));
  test('rejects Feb 30', () => assert.equal(validateCalendarDate(2024, 2, 30), null));
  test('rejects March 32', () => assert.equal(validateCalendarDate(2011, 3, 32), null));
  test('rejects year before 1970', () => assert.equal(validateCalendarDate(1969, 1, 1), null));
  test('accepts leap day', () => assert.equal(validateCalendarDate(2024, 2, 29), '2024-02-29'));
  test('rejects non-leap Feb 29', () => assert.equal(validateCalendarDate(2025, 2, 29), null));
});

describe('normalizeDate', () => {
  // Ordinal suffixes (the 4,128 broken reviews)
  test('February 11th, 2026', () => assert.equal(normalizeDate('February 11th, 2026'), '2026-02-11'));
  test('October 6th, 2022', () => assert.equal(normalizeDate('October 6th, 2022'), '2022-10-06'));
  test('January 22nd, 2025', () => assert.equal(normalizeDate('January 22nd, 2025'), '2025-01-22'));
  test('March 1st, 2024', () => assert.equal(normalizeDate('March 1st, 2024'), '2024-03-01'));
  test('April 3rd, 2025', () => assert.equal(normalizeDate('April 3rd, 2025'), '2025-04-03'));
  test('December 20th, 2024', () => assert.equal(normalizeDate('December 20th, 2024'), '2024-12-20'));

  // UK format
  test('11 February 2026', () => assert.equal(normalizeDate('11 February 2026'), '2026-02-11'));
  test('22nd March 2025', () => assert.equal(normalizeDate('22nd March 2025'), '2025-03-22'));
  test('1st January 2024', () => assert.equal(normalizeDate('1st January 2024'), '2024-01-01'));

  // Already normalized
  test('YYYY-MM-DD passthrough', () => assert.equal(normalizeDate('2026-02-11'), '2026-02-11'));

  // ISO timestamps
  test('ISO timestamp', () => assert.equal(normalizeDate('2026-02-11T05:00:00Z'), '2026-02-11'));
  test('ISO with offset', () => assert.equal(normalizeDate('2025-10-06T12:00:00-04:00'), '2025-10-06'));

  // US format without ordinals
  test('February 11, 2026', () => assert.equal(normalizeDate('February 11, 2026'), '2026-02-11'));
  test('March 1, 2024', () => assert.equal(normalizeDate('March 1, 2024'), '2024-03-01'));

  // Edge cases → null
  test('null input', () => assert.equal(normalizeDate(null), null));
  test('empty string', () => assert.equal(normalizeDate(''), null));
  test('undefined', () => assert.equal(normalizeDate(undefined), null));
  test('"For a previous production"', () => assert.equal(normalizeDate('For a previous production'), null));
  test('March 32, 2011 (invalid day)', () => assert.equal(normalizeDate('March 32, 2011'), null));
  test('Feb 30 (invalid date)', () => assert.equal(normalizeDate('February 30th, 2024'), null));
});

describe('parseDate', () => {
  test('returns Date object for valid input', () => {
    const d = parseDate('February 11th, 2026');
    assert.ok(d instanceof Date);
    assert.equal(d.toISOString().slice(0, 10), '2026-02-11');
  });
  test('returns null for invalid input', () => assert.equal(parseDate('March 32, 2011'), null));
  test('returns null for null', () => assert.equal(parseDate(null), null));
  test('handles UK format', () => {
    const d = parseDate('22nd March 2025');
    assert.ok(d instanceof Date);
    assert.equal(d.toISOString().slice(0, 10), '2025-03-22');
  });
});
