import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
// BRO-7931 #9 class guard: the coverage audit must call the scraper's parser,
// never keep a private copy of the roundup walk (copy undercounted 0 vs 8-12).
const src = fs.readFileSync(new URL('../audit-aggregator-coverage.js', import.meta.url), 'utf8');
test('audit imports the real NYC Theatre parser', () => {
  assert.match(src, /require\('\.\/scrape-nyc-theatre-roundups'\)/);
  assert.match(src, /extractReviewsFromRoundup\(/);
});
test('audit has no private heading-walk copy', () => {
  const fn = src.slice(src.indexOf('function extractNYCTheatreCount'), src.indexOf('function extractBWWReviewsCount'));
  assert.doesNotMatch(fn, /inReviewSection/);
});
