// BRO-5319: exercise the production extractors with injected calendar clocks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractSingleDate } = require('./text-single-date');
const { extractDateFromUrl } = require('./rebuild-helpers');

function setClock(t, year, month = 0, day = 1) {
  // Test-scoped timers restore Date automatically, including on assertion failure.
  // Freeze before calling the already-loaded modules to catch cached year caps.
  t.mock.timers.enable({ apis: ['Date'], now: new Date(year, month, day, 12) });
}

const urlCases = [
  { name: 'slash date', url: y => `https://example.com/${y}/07/14/review/`, result: y => ({ date: `${y}-07-14`, source: 'url-ymd' }) },
  { name: 'Guardian date', url: y => `https://www.theguardian.com/stage/${y}/jul/14/review`, result: y => ({ date: `${y}-07-14`, source: 'url-guardian' }) },
  { name: 'compact date', url: y => `https://www.broadwayworld.com/article/Review-${y}0714`, result: y => ({ date: `${y}-07-14`, source: 'url-compact' }) },
  { name: 'dash date', url: y => `https://example.com/story/${y}-07-14/review`, result: y => ({ date: `${y}-07-14`, source: 'url-dash' }) },
  { name: 'Blogspot month', url: y => `https://reviews.blogspot.com/${y}/07/review.html`, result: y => ({ date: `${y}-07`, source: 'url-blogspot-ym' }) },
  { name: 'year only', url: y => `https://example.com/${y}/review`, result: y => ({ date: null, yearOnly: y, source: 'url-year-only' }) },
];

for (const year of [2026, 2027, 2028, 2035]) {
  for (const [name, text] of [
    ['month first', y => `By Jane Smith\nJuly 14th, ${y}\nReview`],
    ['day first', y => `By Jane Smith\n14th July, ${y}\nReview`],
  ]) {
    test(`text ${name}: ${year} clock accepts through next year only`, t => {
      setClock(t, year);
      assert.equal(extractSingleDate(text(year)), `${year}-07-14`);
      assert.equal(extractSingleDate(text(year + 1)), `${year + 1}-07-14`);
      assert.equal(extractSingleDate(text(year + 2)), null);
    });
  }

  for (const { name, url, result } of urlCases) {
    test(`URL ${name}: ${year} clock accepts through next year only`, t => {
      setClock(t, year);
      // 2026 is a title year only for the bare-year pattern (BRO-6585).
      if (year !== 2026 || name !== 'year only') assert.deepEqual(extractDateFromUrl(url(year)), result(year));
      assert.deepEqual(extractDateFromUrl(url(year + 1)), result(year + 1));
      assert.equal(extractDateFromUrl(url(year + 2)), null);
    });
  }
}

test('Talkin Broadway dates use the moving cap within its two-digit century convention', t => {
  setClock(t, 2028);
  assert.deepEqual(extractDateFromUrl('https://www.talkinbroadway.com/page/ob/07_14_28.html'), { date: '2028-07-14', source: 'url-tb-ob' });
  assert.deepEqual(extractDateFromUrl('https://www.talkinbroadway.com/ob/07_14_29b.html'), { date: '2029-07-14', source: 'url-tb-ob' });
  assert.equal(extractDateFromUrl('https://www.talkinbroadway.com/page/ob/07_14_30.html'), null);
});

test('both extractors advance their cap at the calendar year rollover', t => {
  setClock(t, 2026, 11, 31);
  const text = 'July 14, 2028';
  assert.equal(extractSingleDate(text), null);
  for (const { url } of urlCases) assert.equal(extractDateFromUrl(url(2028)), null);

  t.mock.timers.setTime(new Date(2027, 0, 1, 12).getTime());
  assert.equal(extractSingleDate(text), '2028-07-14');
  for (const { url, result } of urlCases) assert.deepEqual(extractDateFromUrl(url(2028)), result(2028));
});

test('text extraction keeps its strict calendar, single-date and header guards', t => {
  setClock(t, 2028);
  assert.equal(extractSingleDate('February 29, 2028'), '2028-02-29');
  for (const text of [
    'February 29, 2029', 'April 31, 2029', 'January 1, 1969',
    'July 14, 2028 and July 15, 2028', 'Playing through July 14, 2028',
    `${'x'.repeat(501)} July 14, 2028`, '', null, undefined,
  ]) assert.equal(extractSingleDate(text), null, String(text));
});

test('URL extraction keeps calendar and title-year guards with the later clock', t => {
  setClock(t, 2028);
  assert.deepEqual(extractDateFromUrl('https://example.com/2028/02/29/review/'), { date: '2028-02-29', source: 'url-ymd' });
  // Invalid full dates can fall back to year-only; they must never roll over.
  assert.deepEqual(extractDateFromUrl('https://example.com/2029/02/29/review/'), { date: null, yearOnly: 2029, source: 'url-year-only' });
  for (const url of [
    'https://example.com/2029-04-31/review', 'https://example.com/1969/07/14/review/',
    'https://example.com/1984/07/14/review/', 'https://example.com/review?date=2029-07-14',
    '', null, undefined,
  ]) assert.equal(extractDateFromUrl(url), null, String(url));
});
