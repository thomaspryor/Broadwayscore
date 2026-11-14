import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { buildBoard, ledgerFilesForBoard } = createRequire(import.meta.url)('./review-forecast-board.js');

const row = (showId, recordedAt, openingDate, forecast, extra = {}) => ({ showId, recordedAt, openingDate, forecast, lo80: forecast - 14, hi80: forecast + 12, categoryMean: 70, audience: { combined: 80, totalCount: 100 }, ...extra });
const today = '2026-11-20';

test('BRO-7384: a show opened 30 days ago stays waiting after more than 20 daily ledger files', () => {
  const files = new Map();
  for (let daysAgo = 40; daysAgo >= 0; daysAgo--) {
    const date = new Date(Date.parse(today) - daysAgo * 86400000).toISOString().slice(0, 10);
    files.set(`${date}.jsonl`, [row('upcoming', date, '2026-12-01', 75)]);
  }
  files.get('2026-10-19.jsonl').push(row('overdue', '2026-10-19', '2026-10-21', 60));
  files.get('2026-10-20.jsonl').push(row('overdue', '2026-10-20', '2026-10-21', 64));
  files.get('2026-11-17.jsonl').push(row('recent', '2026-11-17', '2026-11-18', 72));
  const grades = [{ showId: 'graded', openingDate: '2026-09-01', forecast: 78, criticScore: 80, missForecast: 2, missCategoryMean: 10, inRange80: true }];
  const names = [...files.keys()].reverse().concat('README.md');
  const b = buildBoard({ ledgerRows: ledgerFilesForBoard(names).flatMap((name) => files.get(name)), grades, today });
  const overdue = b.entries.find((e) => e.showId === 'overdue');
  assert.ok(overdue, 'an ungraded show must not disappear when its last forecast leaves a 20-file window');
  assert.equal(overdue.state, 'awaiting-grade');
  assert.equal(overdue.group, 'waiting');
  assert.equal(overdue.forecast, 64, 'keep the last forecast strictly before opening');
  assert.equal(overdue.forecastRecordedAt, '2026-10-20');
  assert.equal(overdue.gradeDueOn, '2026-11-04');
  assert.equal(b.summary.awaitingGrade, 2);
  assert.deepEqual(b.entries.map((e) => [e.showId, e.state]), [
    ['upcoming', 'upcoming'], ['recent', 'awaiting-grade'], ['overdue', 'awaiting-grade'], ['graded', 'graded'],
  ]);
  assert.equal(b.entries[0].forecastRecordedAt, today);
  assert.equal(b.summary.gradedShows, 1);
  assert.equal(b.summary.ourMiss, 2);
});

test('ledger selection keeps sparse history, ignores other files, and does not mutate the listing', () => {
  const names = ['2026-11-20.jsonl', 'notes.json', '2025-01-01.jsonl', 'README.md'];
  assert.deepEqual(ledgerFilesForBoard(names), ['2025-01-01.jsonl', '2026-11-20.jsonl']);
  assert.equal(names[0], '2026-11-20.jsonl');
  assert.deepEqual(ledgerFilesForBoard([]), []);
});

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

test('v2 shadow fields and the soon/later/graded groups (BRO-7357), tolerant of rows without v2', () => {
  const ledgerRows = [
    { showId: 'a', recordedAt: '2026-11-10', openingDate: '2026-11-20', forecast: 70, lo80: 56, hi80: 82, categoryMean: 67, audience: { combined: null, totalCount: 0 }, v2: { forecast: 74, lo80: 60, hi80: 86, inputsPresent: ['v1', 'showScore'], modelVersion: 'v2', showScoreMixedProductions: false } },
    { showId: 'b', recordedAt: '2026-11-10', openingDate: '2027-02-01', forecast: 66, lo80: 50, hi80: 80, categoryMean: 65, audience: { combined: null, totalCount: 0 } },
  ];
  const b = buildBoard({ ledgerRows, grades: [], today: '2026-11-11' });
  const a = b.entries.find((e) => e.showId === 'a');
  const later = b.entries.find((e) => e.showId === 'b');
  assert.equal(a.group, 'soon'); assert.equal(a.forecastV2, 74); assert.equal(a.v2UsedShowScore, true);
  assert.equal(later.group, 'later'); assert.equal(later.forecastV2, null); assert.equal(later.v2UsedShowScore, false);
});

test('confidence follows the inputs behind the forecast', () => {
  const { confidenceOf } = createRequire(import.meta.url)('./review-forecast-board.js');
  const full = { inputs: { priorRun: true, previewGrosses: true, peopleWithHistory: ['dir', 'writer'] }, audience: { totalCount: 300 } };
  const bare = { inputs: { priorRun: false, previewGrosses: false, peopleWithHistory: [] }, audience: { totalCount: 0 } };
  const mid = { inputs: { priorRun: true, previewGrosses: false, peopleWithHistory: ['writer'] }, audience: { totalCount: 0 } };
  assert.equal(confidenceOf(full).level, 'High');
  assert.equal(confidenceOf(bare).level, 'Low');
  assert.equal(confidenceOf(mid).level, 'Low');
  assert.equal(confidenceOf({ ...mid, audience: { totalCount: 80 } }).level, 'Medium');
  assert.match(confidenceOf(bare).basis, /no prior run/);
});

test('opened shows waiting on a grade get their own group, and a malformed record does not blank the board (ship-check)', () => {
  const good = { showId: 'ok', recordedAt: '2026-11-10T10:00:00Z', openingDate: '2026-12-01', forecast: 70, lo80: 56, hi80: 84 };
  const open = { showId: 'open', recordedAt: '2026-11-01T10:00:00Z', openingDate: '2026-11-05', forecast: 66, lo80: 52, hi80: 80 };
  const bad = { showId: 'bad', recordedAt: '2026-11-10T10:00:00Z', forecast: 60 };
  const b = buildBoard({ ledgerRows: [good, open, bad], grades: [{ showId: 'nodate' }], today: '2026-11-11' });
  assert.deepEqual(b.entries.map((e) => [e.showId, e.group]), [['ok', 'soon'], ['open', 'waiting']]);
});

test('confidence basis never says "all inputs present" while a point is missing (ship-check)', () => {
  const { confidenceOf } = createRequire(import.meta.url)('./review-forecast-board.js');
  const full = { inputs: { priorRun: true, previewGrosses: true, peopleWithHistory: ['a', 'b'] }, audience: { totalCount: 300 } };
  assert.equal(confidenceOf(full).basis, 'all inputs present');
  const thin = { inputs: { priorRun: true, previewGrosses: true, peopleWithHistory: [] }, audience: { totalCount: 50 } };
  assert.equal(confidenceOf(thin).level, 'Medium');
  assert.match(confidenceOf(thin).basis, /few audience votes/);
  assert.match(confidenceOf(thin).basis, /track record/);
});
