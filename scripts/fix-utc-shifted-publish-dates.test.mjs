import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { utcShiftCorrection } = require('./fix-utc-shifted-publish-dates');

test('stored = permalink + 1 day is corrected to the permalink date', () => {
  assert.equal(utcShiftCorrection({ publishDate: '2026-10-16', source: 'rss-discovery', url: 'https://nystagereview.com/2026/10/15/memoirs/' }), '2026-10-15');
  assert.equal(utcShiftCorrection({ publishDate: '2027-01-01', source: 'serp-discovery', url: 'https://x.com/2026/12/31/a/' }), '2026-12-31');
});
test('aggregator-supplied and legacy dates are left alone; so are plan-edited records', () => {
  const base = { publishDate: '2026-10-16', url: 'https://x.com/2026/10/15/a/' };
  assert.equal(utcShiftCorrection({ ...base, source: 'show-score' }), null);
  assert.equal(utcShiftCorrection({ ...base, source: 'dtli' }), null);
  assert.equal(utcShiftCorrection({ ...base }), null);
  assert.equal(utcShiftCorrection({ ...base, source: 'rss-discovery', approvedFixes: [{ fixId: 'bro-5499-c' }] }), null);
});
test('no change when equal, earlier, two days apart, undated, or without a permalink', () => {
  const u = 'https://x.com/2026/10/15/a/';
  for (const pd of ['2026-10-15', '2026-10-14', '2026-10-17', undefined]) assert.equal(utcShiftCorrection({ publishDate: pd, source: 'rss-discovery', url: u }), null);
  assert.equal(utcShiftCorrection({ publishDate: '2026-10-16', source: 'rss-discovery', url: 'https://x.com/reviews/a' }), null);
  assert.equal(utcShiftCorrection({ publishDate: '2026-10-16T01:00:00', source: 'rss-discovery', url: u }), null);
});
test('human-verified and locked records are left alone', () => {
  const u = 'https://x.com/2026/10/15/a/';
  assert.equal(utcShiftCorrection({ publishDate: '2026-10-16', source: 'rss-discovery', url: u, dateSource: 'human-page-verified' }), null);
  assert.equal(utcShiftCorrection({ publishDate: '2026-10-16', source: 'rss-discovery', url: u, _locked: true }), null);
});
