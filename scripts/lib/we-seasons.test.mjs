import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  getSeasonForDate,
  getSeasonDates,
  isDateInSeason,
  parseSeasonYears,
  getSeasonRange,
  validateSeason,
  formatSeasonDisplay,
} = require('./we-seasons.js');

test('getSeasonForDate: Sept 1 opening starts the new season', () => {
  assert.equal(getSeasonForDate('2024-09-01'), '2024-2025');
});

test('getSeasonForDate: Aug 31 opening is still the prior season', () => {
  assert.equal(getSeasonForDate('2025-08-31'), '2024-2025');
});

test('getSeasonForDate: a mid-season opening (Juno and the Paycock, Oct 3)', () => {
  assert.equal(getSeasonForDate('2024-10-03'), '2024-2025');
});

test('getSeasonForDate: a spring opening falls in the season that started the prior autumn', () => {
  assert.equal(getSeasonForDate('2025-03-15'), '2024-2025');
});

test('getSeasonForDate: throws on an invalid date', () => {
  assert.throws(() => getSeasonForDate('not-a-date'));
});

test('getSeasonDates: returns Sept 1 - Aug 31 boundaries', () => {
  const { start, end } = getSeasonDates('2024-2025');
  assert.equal(start.getFullYear(), 2024);
  assert.equal(start.getMonth(), 8); // September
  assert.equal(start.getDate(), 1);
  assert.equal(end.getFullYear(), 2025);
  assert.equal(end.getMonth(), 7); // August
  assert.equal(end.getDate(), 31);
});

test('getSeasonDates: rejects non-consecutive years', () => {
  assert.throws(() => getSeasonDates('2024-2026'));
});

test('isDateInSeason: boundary dates are inclusive', () => {
  assert.equal(isDateInSeason('2024-09-01', '2024-2025'), true);
  assert.equal(isDateInSeason('2025-08-31', '2024-2025'), true);
  assert.equal(isDateInSeason('2025-09-01', '2024-2025'), false);
  assert.equal(isDateInSeason('2024-08-31', '2024-2025'), false);
});

test('parseSeasonYears', () => {
  assert.deepEqual(parseSeasonYears('2024-2025'), { startYear: 2024, endYear: 2025 });
});

test('getSeasonRange', () => {
  assert.deepEqual(getSeasonRange('2022-2023', '2024-2025'), ['2022-2023', '2023-2024', '2024-2025']);
});

test('validateSeason: valid format', () => {
  assert.deepEqual(validateSeason('2024-2025'), { isValid: true });
});

test('validateSeason: rejects malformed input', () => {
  assert.equal(validateSeason('2024').isValid, false);
  assert.equal(validateSeason('2024-2026').isValid, false);
  assert.equal(validateSeason('1899-1900').isValid, false);
});

test('formatSeasonDisplay: running show shows no close season', () => {
  assert.equal(formatSeasonDisplay('2024-10-03', null), '2024-2025 Season (Running)');
});

test('formatSeasonDisplay: closed within the same season', () => {
  assert.equal(formatSeasonDisplay('2024-10-03', '2025-02-01'), '2024-2025 Season');
});

test('formatSeasonDisplay: closed in a later season', () => {
  assert.equal(formatSeasonDisplay('2024-10-03', '2025-11-01'), '2024-2025 - 2025-2026 Seasons');
});
