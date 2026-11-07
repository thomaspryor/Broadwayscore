import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fb = require('../../scripts/lib/fallback-publish-date.js');

test('cdx timestamp parses to a date', () => {
  assert.equal(fb.cdxTimestampToDate('20261030142233'), '2026-10-30');
  assert.equal(fb.cdxTimestampToDate('x'), null);
});
test('archive first capture reads the first data row, skipping the header', async () => {
  const d = await fb.archiveFirstCaptureDate('https://o.test/r', { fetchJson: async () => [['timestamp'], ['20261031010101']] });
  assert.equal(d, '2026-10-31');
});
test('archive lookup failure or empty result returns null', async () => {
  assert.equal(await fb.archiveFirstCaptureDate('u', { fetchJson: async () => { throw new Error('x'); } }), null);
  assert.equal(await fb.archiveFirstCaptureDate('u', { fetchJson: async () => [['timestamp']] }), null);
});
test('listing date wins inside the window, tagged with its source', () => {
  const r = fb.pickFallbackPublishDate({ listingDate: '2026-10-30', listingSource: 'dtli', archiveDate: '2026-10-31', openingDate: '2026-10-29' });
  assert.deepEqual(r, { publishDate: '2026-10-30', dateSource: 'aggregator-listing:dtli' });
});
test('archive capture months after opening is rejected (upper bound proves nothing)', () => {
  assert.equal(fb.pickFallbackPublishDate({ archiveDate: '2027-03-01', openingDate: '2026-10-29' }), null);
});
test('archive capture inside the window is accepted', () => {
  assert.equal(fb.pickFallbackPublishDate({ archiveDate: '2026-11-02', openingDate: '2026-10-29' }).dateSource, 'archive-first-capture');
});
test('listing date outside the window falls through to the archive date', () => {
  const r = fb.pickFallbackPublishDate({ listingDate: '2025-01-01', archiveDate: '2026-10-30', openingDate: '2026-10-29' });
  assert.equal(r.dateSource, 'archive-first-capture');
});

test('fallback date sources count as provisional so a page date replaces them', () => {
  const { isProvisionalPublishDate } = require('../../scripts/lib/publish-date-provenance.js');
  assert.equal(isProvisionalPublishDate({ publishDate: '2026-10-30', dateSource: 'archive-first-capture' }), true);
  assert.equal(isProvisionalPublishDate({ publishDate: '2026-10-30', dateSource: 'aggregator-listing:dtli' }), true);
  assert.equal(isProvisionalPublishDate({ publishDate: '2026-10-30', dateSource: 'text-regex' }), false);
});

test('fallback dates never move a flag in the plausibility guard', () => {
  const { isFallbackPublishDate } = require('../../scripts/lib/publish-date-provenance.js');
  const { evaluateDatePlausibility } = require('../../scripts/lib/date-plausibility.js');
  assert.equal(isFallbackPublishDate({ dateSource: 'archive-first-capture' }), true);
  assert.equal(isFallbackPublishDate({ dateSource: 'aggregator-listing:showscore' }), true);
  assert.equal(isFallbackPublishDate({ dateSource: 'html-meta' }), false);
  const show = { openingDate: '2020-01-01' };
  const base = { publishDate: '2005-01-01' };
  const real = evaluateDatePlausibility({ review: { ...base, dateSource: 'html-meta' }, show });
  const fb = evaluateDatePlausibility({ review: { ...base, dateSource: 'archive-first-capture' }, show });
  assert.equal(fb.implausible, false);
  assert.equal(real.implausible, true, 'a real page date this far before opening still trips the guard');
});

test('guards stay free of the provenance graph (safe-form allowlist stays write-free)', () => {
  const { isFallbackPublishDate } = require('../../scripts/lib/fallback-date-source.js');
  assert.equal(isFallbackPublishDate({ dateSource: 'archive-first-capture' }), true);
  assert.equal(isFallbackPublishDate({ dateSource: 'html-meta' }), false);
});

// BRO-6801: gap audit hands the aggregator listing date to ingest only inside this run's window.
import { createRequire as __cr } from 'node:module';
const __req = __cr(import.meta.url);
const { listingDateForRun } = __req('../../scripts/lib/fallback-publish-date.js');
const { runWindowStartMs } = __req('../../scripts/lib/audit-show-review-gap.js');
test('listingDateForRun: accepts a listing inside the run, refuses prior-production and far-future dates', () => {
  const revival = { openingDate: '2026-10-20', previewsStartDate: '2026-10-01' };
  assert.equal(listingDateForRun('2026-10-21', revival, runWindowStartMs), '2026-10-21');
  assert.equal(listingDateForRun('2016-03-02', revival, runWindowStartMs), null, 'prior production');
  assert.equal(listingDateForRun('2027-03-01', revival, runWindowStartMs), null, 'past opening+60d');
  assert.equal(listingDateForRun(null, revival, runWindowStartMs), null);
  assert.equal(listingDateForRun('October 21', revival, runWindowStartMs), null, 'not ISO');
  assert.equal(listingDateForRun('2026-10-21', { }, runWindowStartMs), null, 'undated show');
});

test('fallbackDateArgs: ingest args only when a listing date exists', () => {
  const { fallbackDateArgs } = __req('../../scripts/lib/fallback-publish-date.js');
  assert.deepEqual(fallbackDateArgs({ date: '2026-10-21', source: 'show-score' }), ['--fallback-publish-date=2026-10-21', '--fallback-date-source=show-score']);
  assert.deepEqual(fallbackDateArgs(null), []);
  assert.deepEqual(fallbackDateArgs({ source: 'x' }), []);
});
