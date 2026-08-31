import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  getSeasonForDate,
  getSeasonDates,
  isDateInSeason,
  getCurrentSeason,
  parseSeasonYears,
  getSeasonRange,
  validateSeason,
  formatSeasonDisplay,
  seasonStandingAnchorDate,
} = require('./broadway-seasons.js');

// Regression guard (2026-08-30, second-opinion review finding on BRO-2548):
// `new Date("2026-07-01")` parses as UTC midnight, which reads back as June
// 30 in America/New_York — silently misclassifying a show opening exactly on
// the season boundary into the PRIOR season. That's the exact cross-season
// mix scripts/newsletter/generate.mjs's seasonStandingFor() was fixed to
// avoid, just shifted one day earlier onto the boundary date itself.
test('getSeasonForDate: the exact July 1 boundary starts the NEW season', () => {
  assert.equal(getSeasonForDate('2026-07-01'), '2026-2027');
});

test('getSeasonForDate: June 30 is still the prior season', () => {
  assert.equal(getSeasonForDate('2026-06-30'), '2025-2026');
});

test('getSeasonForDate: a late-August opening starts the new season', () => {
  assert.equal(getSeasonForDate('2026-08-25'), '2026-2027');
});

test('getSeasonForDate: the exact January 1 UTC-shift edge is unaffected (no season boundary there)', () => {
  assert.equal(getSeasonForDate('2026-01-01'), '2025-2026');
  assert.equal(getSeasonForDate('2025-12-31'), '2025-2026');
});

test('getSeasonForDate accepts a Date object unchanged (local-time getters, no string reparse)', () => {
  assert.equal(getSeasonForDate(new Date(2026, 6, 1)), '2026-2027'); // local July 1
  assert.equal(getSeasonForDate(new Date(2026, 5, 30)), '2025-2026'); // local June 30
});

test('getSeasonDates round-trips getSeasonForDate for boundary dates', () => {
  const { start, end } = getSeasonDates(getSeasonForDate('2026-07-01'));
  assert.ok(start <= new Date('2026-07-01T12:00:00') && end >= new Date('2026-07-01T12:00:00'));
});

test('isDateInSeason agrees with getSeasonForDate at the boundary', () => {
  assert.equal(isDateInSeason('2026-07-01', '2026-2027'), true);
  assert.equal(isDateInSeason('2026-07-01', '2025-2026'), false);
  assert.equal(isDateInSeason('2026-06-30', '2025-2026'), true);
});

// Regression guard (2026-08-30, second-opinion review finding on the review
// above): getSeasonForDate('2026-07-01T00:00:00.000Z') used to fall through
// to the untouched new Date(str) branch and reproduce the exact bug this
// file exists to fix, just for an ISO-datetime string instead of a plain
// date. And isDateInSeason's contract is a plain boolean (its old
// Date-range-comparison implementation never threw on bad input) — delegating
// to getSeasonForDate (which throws by design) must not leak that throw.
test('getSeasonForDate: an ISO-datetime string with a date component is parsed the same as the plain date', () => {
  assert.equal(getSeasonForDate('2026-07-01T00:00:00.000Z'), '2026-2027');
  assert.equal(getSeasonForDate('2026-06-30T23:59:59.999Z'), '2025-2026');
});

test('isDateInSeason returns false (never throws) for unparseable input', () => {
  assert.equal(isDateInSeason('not-a-date', '2026-2027'), false);
  assert.equal(isDateInSeason(new Date('garbage'), '2026-2027'), false);
  assert.doesNotThrow(() => isDateInSeason('not-a-date', '2026-2027'));
});

test('getCurrentSeason matches getSeasonForDate(now)', () => {
  assert.equal(getCurrentSeason(), getSeasonForDate(new Date()));
});

// Regression guard (BRO-2564): scripts/newsletter/generate.mjs's
// seasonStandingFor() used to always key the season comparison off
// openedShow.openingDate, even for a reopening whose ORIGINAL run opened
// seasons ago. openingEventsForWeek() already treats reopeningDate as the
// qualifying date for a reopening event (a show can appear in the week's
// openings purely because it reopened, not because it opened) — the season
// anchor must follow the same precedence, or the "New Plays This Season"
// card silently compares a reopening against a season it isn't returning in.
test('seasonStandingAnchorDate: a reopening show anchors on reopeningDate, not the stale original opening', () => {
  const show = { openingDate: '2023-01-10', reopeningDate: '2026-08-20' };
  const anchor = seasonStandingAnchorDate(show, /* isReopening */ true);
  assert.equal(anchor, '2026-08-20');
  // The bug this fixes: anchoring on openingDate instead would land in a
  // completely different, stale season.
  assert.notEqual(getSeasonForDate(anchor), getSeasonForDate(show.openingDate));
  assert.equal(getSeasonForDate(anchor), '2026-2027');
  assert.equal(getSeasonForDate(show.openingDate), '2022-2023');
});

test('seasonStandingAnchorDate: a normal (non-reopening) opening still anchors on openingDate', () => {
  const show = { openingDate: '2026-08-25', reopeningDate: undefined };
  assert.equal(seasonStandingAnchorDate(show, false), '2026-08-25');
});

test('seasonStandingAnchorDate: isReopening=true but no reopeningDate on the show falls back to openingDate', () => {
  const show = { openingDate: '2026-08-25' };
  assert.equal(seasonStandingAnchorDate(show, true), '2026-08-25');
});

test('parseSeasonYears / getSeasonRange / validateSeason / formatSeasonDisplay basics', () => {
  assert.deepEqual(parseSeasonYears('2025-2026'), { startYear: 2025, endYear: 2026 });
  assert.deepEqual(getSeasonRange('2024-2025', '2026-2027'), ['2024-2025', '2025-2026', '2026-2027']);
  assert.equal(validateSeason('2025-2026').isValid, true);
  assert.equal(validateSeason('2025-2027').isValid, false);
  assert.equal(formatSeasonDisplay('2026-08-25', null), '2026-2027 Season (Running)');
});
