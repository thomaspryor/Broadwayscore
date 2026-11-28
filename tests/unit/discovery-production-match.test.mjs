// Regression coverage for card #1446 (P0: Broadway discovery matching drops
// real productions) — three independent defects in scripts/discover-new-shows.js
// that each silently dropped or stale-locked real announced productions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { checkForDuplicate } = require('../../scripts/lib/deduplication.js');
const { isOneNightShow } = require('../../scripts/discover-new-shows.js');
const { computeShowReconciliation } = require('../../scripts/lib/discovery-reconcile.js');

// ── Gap A: title-only matching suppressed new productions at a reused venue ──
// (real incident: a 2026 Winter Garden "Much Ado About Nothing" candidate,
// with only a previewsStartDate — openingDate is always null pre-IBDB — was
// matched to the 1972 Winter Garden production because isMultiProduction's
// year check only ever looked at openingDate/id-suffix, both absent.)

test('Gap A: new candidate at a venue with a decades-old closed production is NOT a duplicate', () => {
  const historical = {
    id: 'much-ado-about-nothing-1972',
    title: 'Much Ado About Nothing',
    status: 'closed',
    category: 'broadway',
    venue: 'Winter Garden Theatre',
    openingDate: '1972-11-11',
    closingDate: '1973-02-11',
  };
  const candidate = {
    title: 'Much Ado About Nothing',
    category: 'broadway',
    venue: 'Winter Garden Theatre',
    openingDate: null,
    previewsStartDate: '2026-10-31',
  };
  const result = checkForDuplicate(candidate, [historical]);
  assert.equal(result.isDuplicate, false, `should not match the 1972 production: ${result.reason}`);
});

test('Gap A regression: genuine rediscovery of the SAME upcoming production still dedupes', () => {
  const existing = {
    id: 'billy-crystal-860-2026',
    title: 'Billy Crystal 860',
    status: 'announced',
    category: 'broadway',
    venue: 'Music Box Theatre',
    openingDate: null,
    previewsStartDate: '2026-09-01',
  };
  const candidate = {
    title: 'Billy Crystal 860',
    category: 'broadway',
    venue: 'Music Box Theatre',
    openingDate: null,
    previewsStartDate: '2026-09-05', // same run, slightly refined date
  };
  const result = checkForDuplicate(candidate, [existing]);
  assert.equal(result.isDuplicate, true, 'rediscovering the same unopened show must still dedupe');
});

test('Gap A: a genuinely different upcoming production at a shared venue is NOT a duplicate', () => {
  const existing = {
    id: 'some-play-2026',
    title: 'Some Play',
    status: 'announced',
    category: 'broadway',
    venue: 'Todd Haimes Theatre',
    previewsStartDate: '2026-09-01',
  };
  const candidate = {
    title: 'Some Play',
    category: 'broadway',
    venue: 'Todd Haimes Theatre',
    previewsStartDate: '2029-02-01', // far apart run — different production
  };
  const result = checkForDuplicate(candidate, [existing]);
  assert.equal(result.isDuplicate, false, 'runs years apart at the same venue should not collapse into one');
});

// ── Gap B: the one-night-events filter ate real productions ──
// TodayTix returns the literal string "null" (not JSON null) for shows
// without confirmed run dates — "null" === "null" made every not-yet-on-sale
// announced show look like a one-night event.

test('Gap B: string "null"/"null" dates are NOT treated as a one-night show', () => {
  const show = { displayName: 'Mix and Master', startDate: 'null', endDate: 'null' };
  assert.equal(isOneNightShow(show), false);
});

test('Gap B: a real one-night event (same real date twice) is still filtered', () => {
  const show = { displayName: 'Gary Gulman Holiday Show', startDate: '2026-12-05', endDate: '2026-12-05' };
  assert.equal(isOneNightShow(show), true);
});

test('Gap B: a real multi-date run is not filtered', () => {
  const show = { displayName: 'Wicked', startDate: '2003-10-30', endDate: '2099-01-01' };
  assert.equal(isOneNightShow(show), false);
});

// ── Gap C: matched-existing shows never got their stale dates refreshed ──

test('Gap C: an announced show with a stale preview date is refreshed from a rediscovery', () => {
  const existing = {
    id: 'wanted-2022',
    title: 'Wanted',
    status: 'announced',
    venue: 'James Earl Jones Theatre',
    openingDate: null,
    previewsStartDate: '2022-10-28',
  };
  const candidate = {
    title: 'Wanted',
    venue: 'James Earl Jones Theatre',
    openingDate: '2026-11-08',
    openingDateSource: 'playbill',
    previewsStartDate: '2026-10-15',
  };
  const patch = computeShowReconciliation(existing, candidate);
  assert.ok(patch, 'expected a reconciliation patch');
  assert.equal(patch.previewsStartDate, '2026-10-15');
  assert.equal(patch.openingDate, '2026-11-08');
  assert.equal(patch.openingDateSource, 'playbill');
});

test('Gap C: an open/live show is never touched by reconciliation', () => {
  const existing = {
    id: 'hamilton-2015',
    title: 'Hamilton',
    status: 'open',
    venue: 'Richard Rodgers Theatre',
    openingDate: '2015-08-06',
  };
  const candidate = {
    title: 'Hamilton',
    venue: 'Richard Rodgers Theatre',
    openingDate: '2026-01-01', // bogus/irrelevant TodayTix re-listing date
  };
  assert.equal(computeShowReconciliation(existing, candidate), null);
});

test('Gap C: a closed historical show is never touched by reconciliation', () => {
  const existing = {
    id: 'much-ado-about-nothing-1972',
    title: 'Much Ado About Nothing',
    status: 'closed',
    venue: 'Winter Garden Theatre',
    openingDate: '1972-11-11',
  };
  const candidate = { title: 'Much Ado About Nothing', venue: 'Winter Garden Theatre', openingDate: '2026-11-19' };
  assert.equal(computeShowReconciliation(existing, candidate), null);
});

test('Gap C: no patch when the candidate has nothing new to offer', () => {
  const existing = {
    id: 'wanted-2022',
    title: 'Wanted',
    status: 'announced',
    venue: 'James Earl Jones Theatre',
    previewsStartDate: '2026-10-15',
  };
  const candidate = { title: 'Wanted', venue: 'James Earl Jones Theatre', previewsStartDate: '2026-10-15' };
  assert.equal(computeShowReconciliation(existing, candidate), null);
});

test('Gap C: a curated openingDateSource (e.g. press-night inferred from reviews) is never clobbered', () => {
  const existing = {
    id: 'some-show-west-end-2026',
    title: 'Some Show',
    status: 'upcoming',
    venue: 'Some Theatre',
    openingDate: '2026-09-01',
    openingDateSource: 'review-derived-press-night',
    previewsStartDate: '2026-08-15',
  };
  const candidate = {
    title: 'Some Show',
    venue: 'A Different Theatre',
    openingDate: '2026-09-15',
    openingDateSource: 'todaytix',
    previewsStartDate: '2026-08-01',
  };
  assert.equal(computeShowReconciliation(existing, candidate), null, 'curated source must block ALL fields, not just openingDate');
});

test('Gap C: a title mismatch (e.g. a recycled TodayTix ID pointing at an unrelated show) refuses to patch', () => {
  const existing = {
    id: 'some-play-2026',
    title: 'Some Play',
    status: 'announced',
    venue: 'Some Theatre',
    previewsStartDate: '2026-09-01',
  };
  const candidate = {
    // Same todaytixId, but an unrelated production — this is the ID-recycling
    // scenario scripts/lib/todaytix-dates.js documents. Nothing here should
    // resemble "Some Play" the way isMultiProduction's title checks would demand.
    title: 'A Completely Different Show',
    venue: 'A Different Theatre Entirely',
    previewsStartDate: '2027-03-01',
  };
  assert.equal(computeShowReconciliation(existing, candidate), null, 'mismatched titles must never patch venue/dates onto an unrelated entry');
});

test('Gap C: a candidate openingDate with no source is refused (never write an unattributed date)', () => {
  const existing = {
    id: 'some-show-2026',
    title: 'Some Show',
    status: 'announced',
    venue: 'Some Theatre',
    openingDate: null,
    openingDateSource: null,
  };
  const candidate = { title: 'Some Show', venue: 'Some Theatre', openingDate: '2026-09-15' };
  const patch = computeShowReconciliation(existing, candidate);
  assert.equal(patch, null, 'no venue/date change offered besides the unattributed openingDate, so no patch at all');
});
