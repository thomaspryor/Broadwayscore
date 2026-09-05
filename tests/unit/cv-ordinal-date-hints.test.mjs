/**
 * Regression tests: ordinal publishDates must reach content-verifier's two
 * prompt-building date hints.
 *
 * BRO-2835 fixed `new Date(...)`-on-an-ordinal-date at the temporal GUARD
 * (review-guards.js) and at the persisted annotation (content-verifier.js
 * daysFromOpening). It left the two PROMPT sites in buildVerificationPrompt
 * still using bare `new Date(...)`.
 *
 * Measured on the real corpus at the time of the fix:
 *   35,167 review-text files carry a publishDate
 *    4,717 of them (13.4%) are Invalid Date under bare `new Date()`
 *    4,691 of those parse fine via parseDate() || parseHistoricalDate()
 *    2,079 are within 30 days of their show's openingDate, so they SHOULD have
 *          received the opening-week temporalHint and silently did not
 *       24 of those are complete/truncated reviews still flagged
 *          wrongProduction, including NYT/Jesse Green on 1776-2022 and
 *          WSJ on death-of-a-salesman-2022, both published ON opening day
 *        4 lose a real urlYearConflict (gap >= 3 years)
 *
 * NaN is the reason it was silent: `NaN <= 30` is false and
 * `Number.isFinite(NaN)` is false, so both hints simply never appended. No
 * error, no log line — the prompt just lost its opening-week safety net.
 *
 * Run: node --test tests/unit/cv-ordinal-date-hints.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildVerificationPrompt } = require('../../scripts/lib/content-verifier.js');

const base = {
  scrapedText: 'A review of the production. '.repeat(60),
  showTitle: '1776',
  outletName: 'The New York Times',
  criticName: 'Jesse Green',
  venue: 'American Airlines Theatre',
  market: 'broadway',
};

describe('ordinal publishDate reaches the opening-week temporal hint', () => {
  test('ordinal date on opening day produces the hint', () => {
    const { prompt } = buildVerificationPrompt({
      ...base,
      openingDate: '2022-10-06',
      publishDate: 'October 6th, 2022',
    });
    assert.ok(
      prompt.includes('published on opening night'),
      'ordinal publishDate must reach the opening-week temporal hint'
    );
    assert.ok(!prompt.includes('NaN'), 'prompt must never contain a NaN day count');
  });

  test('ISO date keeps working — no regression on the 86.6% path', () => {
    const { prompt } = buildVerificationPrompt({
      ...base,
      openingDate: '2022-10-06',
      publishDate: '2022-10-06',
    });
    assert.ok(prompt.includes('published on opening night'));
  });

  test('ordinal date FAR from opening does not produce the hint', () => {
    // Guards the fix against degenerating into an always-on hint. The whole
    // value of the temporal nudge is that it is scoped to the opening window.
    const { prompt } = buildVerificationPrompt({
      ...base,
      openingDate: '2022-10-06',
      publishDate: 'March 3rd, 2024',
    });
    assert.ok(
      !prompt.includes('Reviews published near opening night'),
      'a review ~1.4 years from opening must not get the opening-week hint'
    );
  });

  test('pre-1970 ordinal date still gets the hint (historical fallback is load-bearing)', () => {
    // parseDate() enforces normalizeDate()'s 1970-2030 calendar floor and
    // returns null here. Without the parseHistoricalDate leg this fix would
    // NEWLY strip the hint from genuine mid-century reviews — the same trap
    // BRO-2835's review caught on the guard side.
    const { prompt } = buildVerificationPrompt({
      ...base,
      showTitle: 'Fiddler on the Roof',
      openingDate: '1964-09-22',
      publishDate: 'September 23rd, 1964',
    });
    assert.ok(
      prompt.includes('Reviews published near opening night'),
      'pre-1970 ordinal dates must survive via parseHistoricalDate'
    );
    assert.ok(!prompt.includes('NaN'));
  });
});

describe('ordinal publishDate reaches the URL-year conflict hint', () => {
  test('a real 12-year URL-vs-publishDate gap is surfaced for an ordinal date', () => {
    const { prompt, urlYearConflict } = buildVerificationPrompt({
      ...base,
      showTitle: 'The Lion King',
      openingDate: '2011-01-04',
      publishDate: 'January 4th, 2011',
      url: 'https://variety.com/1999/legit/reviews/the-lion-king-1117492345/',
    });
    assert.ok(
      prompt.includes('URL-YEAR / PUBLISHDATE CONFLICT'),
      'a 12-year gap must be surfaced even when publishDate is ordinal'
    );
    assert.ok(!prompt.includes('year NaN'), 'conflict text must not print NaN');
    // urlYearConflict is PERSISTED onto the review, so a null here is a data
    // defect, not just a missing prompt paragraph.
    assert.deepEqual(urlYearConflict, { urlYear: 1999, publishYear: 2011, gapYears: 12 });
  });

  test('a sub-threshold gap is still not surfaced', () => {
    const { prompt, urlYearConflict } = buildVerificationPrompt({
      ...base,
      openingDate: '2022-10-06',
      publishDate: 'October 6th, 2022',
      url: 'https://variety.com/2021/legit/reviews/1776-1117492345/',
    });
    assert.ok(
      !prompt.includes('URL-YEAR / PUBLISHDATE CONFLICT'),
      'a 1-year gap is below the >=3 threshold and must stay silent'
    );
    assert.equal(urlYearConflict, null);
  });
});
