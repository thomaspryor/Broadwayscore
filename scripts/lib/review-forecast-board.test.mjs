import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { buildBoard } = createRequire(import.meta.url)('./review-forecast-board.js');

const row = (showId, recordedAt, openingDate, forecast, extra = {}) => ({ showId, recordedAt, openingDate, forecast, lo80: forecast - 14, hi80: forecast + 12, categoryMean: 70, audience: { combined: 80, totalCount: 100 }, ...extra });
const today = '2026-11-20';

test('upcoming shows use the newest row and sort first by opening date; opened use the frozen row', () => {
  const ledgerRows = [
    row('late', '2026-11-10', '2027-01-10', 70), row('late', '2026-11-11', '2027-01-10', 72),
    row('soon', '2026-11-11', '2026-12-01', 75),
    row('open', '2026-11-01', '2026-11-18', 60), row('open', '2026-11-17', '2026-11-18', 64), row('open', '2026-11-19', '2026-11-18', 99),
  ];
  const b = buildBoard({ ledgerRows, grades: [], today, titleOf: (id) => (id === 'soon' ? 'Soon Show' : null) });
  assert.deepEqual(b.entries.map((e) => [e.showId, e.state]), [['soon', 'upcoming'], ['late', 'upcoming'], ['open', 'awaiting-grade']]);
  assert.equal(b.entries[1].forecast, 72);
  assert.equal(b.entries[2].forecast, 64, 'frozen = last row strictly before opening night, never the leaked later row');
  assert.equal(b.entries[0].title, 'Soon Show');
  assert.equal(b.entries[1].title, 'late', 'falls back to the show id');
  assert.equal(b.entries[2].gradeDueOn, '2026-12-02');
});

test('graded shows carry the actual score and both misses; summary compares ours to the category average', () => {
  const grades = [
    { showId: 'a', openingDate: '2026-09-01', criticScore: 80, forecast: 78, categoryMean: 70, previewAudience: 85, missForecast: 2, missCategoryMean: 10, inRange80: true, frozenRecordedAt: '2026-08-30' },
    { showId: 'b', openingDate: '2026-09-05', criticScore: 60, forecast: 70, categoryMean: 66, previewAudience: null, missForecast: 10, missCategoryMean: 6, inRange80: false, frozenRecordedAt: '2026-09-04' },
  ];
  const b = buildBoard({ ledgerRows: [], grades, today });
  assert.equal(b.summary.gradedShows, 2);
  assert.equal(b.summary.ourMiss, 6);
  assert.equal(b.summary.categoryMiss, 8);
  assert.equal(b.summary.early, true);
  assert.equal(b.entries[0].showId, 'b', 'graded newest opening first');
  assert.equal(b.entries[0].criticScore, 60);
  assert.equal(b.entries[0].lo80, null, 'range unknown when the ledger row is outside the loaded window');
});

test('empty input gives an empty board, not a crash', () => {
  const b = buildBoard({ ledgerRows: [], grades: [], today });
  assert.equal(b.entries.length, 0);
  assert.equal(b.summary.ourMiss, null);
});
