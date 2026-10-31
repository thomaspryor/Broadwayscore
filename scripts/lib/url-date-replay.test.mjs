import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { diffUrlDate, describeUrlDate } = require('./url-date-replay.js');
const { extractDateFromUrl } = require('./rebuild-helpers.js');

const URL_2026 = 'https://example.com/2026/10/29/theater/a-few-good-men-review.html';

test('identical real extractors report no delta', () => {
  assert.equal(diffUrlDate(extractDateFromUrl, extractDateFromUrl, URL_2026), null);
});

test('synthetic extractDateFromUrl change shows up as a delta', () => {
  // Baseline behaves like the pre-BRO-6585 guard (drops /2026/MM/DD/), working like the fix.
  const oldExtractor = (u) => (/\/2026\//.test(u) ? null : extractDateFromUrl(u));
  const d = diffUrlDate(oldExtractor, extractDateFromUrl, URL_2026);
  assert.ok(d, 'delta expected');
  assert.equal(d.baseline, null);
  assert.equal(d.working.date, '2026-10-29');
  assert.equal(describeUrlDate(d.working), '2026-10-29(url-ymd)');
  assert.equal(describeUrlDate(d.baseline), 'none');
});

test('changed date or source on the same URL is a delta', () => {
  const a = () => ({ date: '2026-10-29', source: 'url-ymd' });
  const b = () => ({ date: '2026-10-28', source: 'url-ymd' });
  const c = () => ({ date: '2026-10-29', source: 'url-dash' });
  assert.ok(diffUrlDate(a, b, 'https://x/y'));
  assert.ok(diffUrlDate(a, c, 'https://x/y'));
});

test('missing url or non-function extractor yields no delta', () => {
  assert.equal(diffUrlDate(extractDateFromUrl, extractDateFromUrl, ''), null);
  assert.equal(diffUrlDate(null, extractDateFromUrl, 'https://x/y'), null);
});

test('scoring-delta.js feeds URL-date flips into the totals, T1 count and report (BRO-6628)', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'scoring-delta.js'), 'utf8');
  assert.match(src, /diffUrlDate\(baselineScoring\.extractDateFromUrl, workingScoring\.extractDateFromUrl, review\.url\)/);
  assert.match(src, /totalFlips = [^;]*urlDateFlips\.length/);
  assert.match(src, /t1Flips = t1InclusionFlips \+ t1ScoreFlips \+ t1UrlDateFlips/);
  assert.match(src, /URL DATE CHANGED:/);
});
