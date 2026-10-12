// BRO-2296: the weekly census-recall run spent 4 of its 5 sample slots on
// shows that opened that same day (excluded later as `settling`), then judged
// the naive arm "regressed" on the single show left. Both halves are pinned
// here: selection skips settling shows, and the detector refuses a verdict on
// a run that measured too few shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pickShows } = require('./audit-serp-census-recall.js');
const { classifySample, detectRecallRegression, summarizeRun } = require('./lib/census-recall.js');

const NOW = Date.parse('2026-10-05T19:43:00Z');

// The 2026-10-05 pool: four same-day openings, then older measurable shows.
const SHOWS = [
  { id: 'torera', title: 'Torera', openingDate: '2026-10-05', status: 'open' },
  { id: 'soon', title: 'Soon', openingDate: '2026-10-05', status: 'open' },
  { id: 'franz', title: 'Franz and Marie', openingDate: '2026-10-05', status: 'open' },
  { id: 'affluenza', title: 'Affluenza', openingDate: '2026-10-05', status: 'open' },
  { id: 'hairy-ape', title: 'The Hairy Ape', openingDate: '2026-10-04', status: 'open' },
  { id: 'a', title: 'A', openingDate: '2026-10-01', status: 'open' },
  { id: 'b', title: 'B', openingDate: '2026-09-28', status: 'open' },
  { id: 'c', title: 'C', openingDate: '2026-09-25', status: 'open' },
  { id: 'd', title: 'D', openingDate: '2026-09-20', status: 'open' },
  { id: 'e', title: 'E', openingDate: '2026-09-15', status: 'open' },
];

test('pickShows fills the sample with measurable shows, skipping recent openings', () => {
  const sel = pickShows(SHOWS, { limit: 5, days: 30, now: NOW, includeUndated: false, settlingHours: 24 });
  // hairy-ape opened the evening of 10-04, ~21h before the run: still settling.
  assert.deepEqual(sel.pool.map(s => s.id), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(sel.settlingSkipped, 5);
});

test('classifySample: a date-only openingDate settles from the END of that day', () => {
  // 10-04 date-only at 10-05 19:43Z: ~43.7h after UTC midnight, but the
  // curtain was the evening of 10-04 — ~20h of indexing at most.
  assert.equal(classifySample({ openingDate: '2026-10-04' }, { now: NOW, settlingHours: 24 }).state, 'settling');
  assert.equal(classifySample({ openingDate: '2026-10-03' }, { now: NOW, settlingHours: 24 }).state, 'measured');
  // A full timestamp is taken at face value.
  assert.equal(classifySample({ openingDate: '2026-10-04T12:00:00Z' }, { now: NOW, settlingHours: 24 }).state, 'measured');
});

test('summarizeRun tallies settling shows skipped at selection', () => {
  const e = summarizeRun({ generatedAt: '2026-10-05T19:43:00Z', shows: [] }, { settlingSkipped: 4 });
  assert.equal(e.excluded.settling, 4);
});

test('pickShows with --settling-hours=0 admits any show whose opening day has ended', () => {
  const sel = pickShows(SHOWS, { limit: 5, days: 30, now: NOW, includeUndated: false, settlingHours: 0 });
  assert.deepEqual(sel.pool.map(s => s.id), ['hairy-ape', 'a', 'b', 'c', 'd']);
  assert.equal(sel.settlingSkipped, 4);
});

// Trend entries shaped like the real 2026-08-24 .. 2026-10-05 ledger rows.
const wk = (date, shows, truthUrls, naive, naiveYield) => ({
  date, shows, truthUrls, excluded: {}, families: { naive }, familyYield: { naive: naiveYield },
});

test('a one-show run is insufficient-sample, not a naive-arm regression (2026-10-05 replay)', () => {
  const r = detectRecallRegression([
    wk('2026-08-24', 5, 125, 0.296, 7.4),
    wk('2026-09-14', 5, 80, 0.463, 7.4),
    wk('2026-09-21', 4, 18, 0.778, 3.5),
    wk('2026-09-28', 3, 54, 0.296, 5.33),
    { ...wk('2026-10-05', 1, 18, 0.167, 3), excluded: { settling: 4 } },
  ]);
  assert.equal(r.verdict, 'insufficient-sample', JSON.stringify(r));
  assert.match(r.reason, /measured only 1 show/);
  assert.match(r.reason, /4 settling/);
});

test('exactly minShows (3) measured shows is judged, not suppressed', () => {
  const r = detectRecallRegression([
    wk('2026-09-14', 5, 120, 0.5, 12),
    wk('2026-09-21', 5, 118, 0.5, 12),
    wk('2026-09-28', 3, 72, 0.2, 4.8),
  ]);
  assert.equal(r.verdict, 'regressed');
});

test('a thin prior run is kept out of the baseline it would distort', () => {
  // Without the filter the 1-show 0.05 row drags the median to 0.275 and the
  // 0.2 latest reads as a small dip; with it, the baseline is 0.5.
  const r = detectRecallRegression([
    wk('2026-09-14', 5, 120, 0.5, 12),
    wk('2026-09-21', 1, 18, 0.05, 1),
    wk('2026-09-28', 5, 122, 0.5, 12),
    wk('2026-10-05', 5, 120, 0.2, 4.8),
  ]);
  assert.equal(r.verdict, 'regressed');
  assert.equal(r.regressions[0].baseline, 0.5);
});

test('the same drop on a full sample still regresses', () => {
  const r = detectRecallRegression([
    wk('2026-08-24', 5, 125, 0.5, 12),
    wk('2026-09-14', 5, 120, 0.5, 12),
    wk('2026-09-21', 5, 118, 0.5, 12),
    wk('2026-09-28', 5, 122, 0.5, 12),
    wk('2026-10-05', 5, 120, 0.2, 4.8),
  ]);
  assert.equal(r.verdict, 'regressed');
});
