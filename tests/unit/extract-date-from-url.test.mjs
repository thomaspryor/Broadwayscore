/**
 * Unit tests for extractDateFromUrl (scripts/lib/rebuild-helpers.js).
 *
 * The pre-opening date guard + flag-wrong-production-by-date.js now rely on this
 * to resolve dates from URLs in more shapes than the old contiguous-YYYYMMDD
 * regex. The behavior this locks in (added 2026-06-17):
 *  - Guardian /YYYY/mon/DD/ and /YYYY/MM/DD/ prior-season URLs resolve, so a
 *    mis-linked prior-production review (e.g. 2017 Playhouse Glengarry) gets a
 *    date and the Date guard can flag it even AFTER the show opens.
 *  - The current season year (2026) is a TITLE_YEAR and is NOT treated as a date,
 *    so genuine current reviews are not given a spurious URL date.
 *  - Venue-only / dateless URLs stay null.
 *  - Bare year alone is never returned as a date (.date) — only as yearOnly,
 *    which the guards intentionally ignore (July-1 imprecision = Class B FPs).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { extractDateFromUrl } = require('../../scripts/lib/rebuild-helpers.js');
const { earliestShowDate } = require('../../scripts/lib/date-guard.js');

describe('earliestShowDate — window anchor hardening', () => {
  test('normal ordering returns previews start', () => {
    assert.equal(earliestShowDate({ previewsStartDate: '2026-06-04', openingDate: '2026-06-17' }), '2026-06-04');
  });
  test('inverted dates (Three Houses) return the EARLIER one, not first-non-null', () => {
    assert.equal(earliestShowDate({ previewsStartDate: '2024-12-04', openingDate: '2024-05-22' }), '2024-05-22');
  });
  test('openingDate only', () => {
    assert.equal(earliestShowDate({ openingDate: '2026-01-10' }), '2026-01-10');
  });
  test('no dates → null', () => {
    assert.equal(earliestShowDate({}), null);
    assert.equal(earliestShowDate(null), null);
  });
});

describe('extractDateFromUrl — date guard inputs', () => {
  test('Guardian /YYYY/mon/DD/ prior-season URL resolves to a full date', () => {
    const r = extractDateFromUrl('https://www.theguardian.com/stage/2017/nov/12/glengarry-glen-ross-review');
    assert.equal(r?.date, '2017-11-12');
  });

  test('/YYYY/MM/DD/ prior-season URL resolves to a full date', () => {
    const r = extractDateFromUrl('https://example.com/2019/12/08/cyrano-review/');
    assert.equal(r?.date, '2019-12-08');
  });

  test('compact YYYYMMDD URL resolves (BWW style)', () => {
    const r = extractDateFromUrl('https://www.broadwayworld.com/article/Review-Roundup-X-20241010');
    assert.equal(r?.date, '2024-10-10');
  });

  test('current-season year 2026 is a TITLE_YEAR — not returned as a .date', () => {
    const r = extractDateFromUrl('https://culturesauce.com/2026/04/25/joe-turners-review/');
    assert.ok(!r || !r.date, 'should not produce a date for a /2026/ URL');
  });

  test('venue-only / dateless URL returns null or no .date', () => {
    const r = extractDateFromUrl('https://theartsdesk.com/theatre/glengarry-glen-ross-playhouse-theatre-review');
    assert.ok(!r || !r.date);
  });

  test('bare year alone never returns a .date (only yearOnly)', () => {
    const r = extractDateFromUrl('https://example.com/2017/some-review-slug');
    assert.ok(!r || !r.date, 'a /YYYY/ path must not yield a full date');
  });

  test('blogspot returns a MONTH-ONLY date — guards must reject (not full YYYY-MM-DD)', () => {
    // The date guards filter on /^\d{4}-\d{2}-\d{2}$/ precisely because this
    // returns YYYY-MM; the day defaults to the 1st and tripped a genuine
    // Bright Star review near the window boundary.
    const r = extractDateFromUrl('http://dougmarino.blogspot.com/2016/02/bright-star.html');
    assert.equal(r?.date, '2016-02');
    assert.ok(!/^\d{4}-\d{2}-\d{2}$/.test(r.date), 'must NOT be a full date');
  });

  test('null/empty URL is handled', () => {
    assert.equal(extractDateFromUrl(null), null);
    assert.equal(extractDateFromUrl(''), null);
  });
});
