/**
 * seasonWindows — Tony season boundaries.
 *
 * Runs the REAL src/lib/stats/season-windows.ts (via tsx, like the other
 * TS-importing tests in this batch). The boundary rule is off-by-one bait:
 * a season runs from the DAY AFTER one ceremony through the DAY OF the next,
 * so a show seen on ceremony day belongs to the season then ending.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  nextDay,
  provisionalSeasonEnd,
  seasonForDate,
  seasonLabel,
  seasonWindows,
  windowForSeason,
} from '../../src/lib/stats/season-windows';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CANON = JSON.parse(readFileSync(join(ROOT, 'public/data/stats-canon.json'), 'utf8'));

// Trimmed ceremony list spanning the COVID gap: 2019, (no 2020), 2021, 2022.
const COVID_CANON = {
  ceremonies: [
    { ceremony: 72, date: '2018-06-10' },
    { ceremony: 73, date: '2019-06-09' },
    { ceremony: 74, date: '2021-09-26' },
    { ceremony: 75, date: '2022-06-12' },
  ],
};

test('nextDay crosses month, year and leap-day boundaries', () => {
  assert.equal(nextDay('2026-06-07'), '2026-06-08');
  assert.equal(nextDay('2026-06-30'), '2026-07-01');
  assert.equal(nextDay('2025-12-31'), '2026-01-01');
  assert.equal(nextDay('2024-02-28'), '2024-02-29');
  assert.equal(nextDay('2023-02-28'), '2023-03-01');
});

test('a window starts the day after the previous ceremony and ends ON the next', () => {
  const w = seasonWindows(COVID_CANON, { today: '2022-07-01' });
  const w75 = w.find((x) => x.ceremony === 75);
  assert.equal(w75.start, '2021-09-27', 'day after the 74th ceremony');
  assert.equal(w75.end, '2022-06-12', 'the 75th ceremony itself');
});

test('BOUNDARY: a show seen ON ceremony day belongs to the season then ending', () => {
  const w = seasonWindows(COVID_CANON, { today: '2022-07-01' });
  // 2022-06-12 is the 75th ceremony itself.
  assert.equal(seasonForDate(w, '2022-06-12').ceremony, 75);
  // One day later is the NEXT season.
  assert.notEqual(seasonForDate(w, '2022-06-13').ceremony, 75);
  // One day earlier is still the same season.
  assert.equal(seasonForDate(w, '2022-06-11').ceremony, 75);
});

test('COVID gap: 2020 and 2021 collapse into one window labelled 2019-20', () => {
  const w = seasonWindows(COVID_CANON, { today: '2022-07-01' });
  const gap = w.find((x) => x.ceremony === 74);
  assert.equal(gap.label, '2019-20', 'the 74th Tonys honored 2019-20, not 2020-21');
  assert.equal(gap.start, '2019-06-10');
  assert.equal(gap.end, '2021-09-26');
  // Everything in the dead zone lands in that one window.
  for (const d of ['2020-01-15', '2020-06-30', '2020-12-31', '2021-05-01', '2021-09-26']) {
    assert.equal(seasonForDate(w, d).ceremony, 74, `${d} should be in the 2019-20 window`);
  }
  // And the season AFTER the gap resumes normal labelling.
  assert.equal(w.find((x) => x.ceremony === 75).label, '2021-22');
});

test('seasonLabel follows the previous ceremony across a skipped year', () => {
  assert.equal(seasonLabel(2022, 2021), '2021-22');
  assert.equal(seasonLabel(2021, 2019), '2019-20'); // COVID gap
  assert.equal(seasonLabel(1947, null), '1946-47'); // first ever
  assert.equal(seasonLabel(2000, 1999), '1999-00');
});

test('provisional end is the June 30 that actually follows the start', () => {
  // A June ceremony rolls to the NEXT June 30, not the one three weeks away.
  assert.equal(provisionalSeasonEnd('2026-06-08'), '2027-06-30');
  assert.equal(provisionalSeasonEnd('2021-09-27'), '2022-06-30');
  assert.equal(provisionalSeasonEnd('1967-03-27'), '1967-06-30');
});

test('the open season is provisional, ends June 30, and has no ceremony number', () => {
  const w = seasonWindows(COVID_CANON, { today: '2022-08-01' });
  const open = w[w.length - 1];
  assert.equal(open.provisional, true);
  assert.equal(open.ceremony, null);
  assert.equal(open.start, '2022-06-13');
  assert.equal(open.end, '2023-06-30');
  assert.equal(open.label, '2022-23');
  // Every other window is settled.
  assert.equal(w.slice(0, -1).filter((x) => x.provisional).length, 0);
});

test('the open season is withheld until it has begun', () => {
  const before = seasonWindows(COVID_CANON, { today: '2022-06-12' });
  assert.equal(before[before.length - 1].provisional, false);
  const after = seasonWindows(COVID_CANON, { today: '2022-06-13' });
  assert.equal(after[after.length - 1].provisional, true);
});

test('the first window is open-ended so pre-1947 entries still bucket', () => {
  const w = seasonWindows(CANON, { today: '2026-07-26' });
  assert.equal(w[0].start, null);
  assert.equal(w[0].label, '1946-47');
  assert.equal(seasonForDate(w, '1901-01-01').ceremony, 1);
});

test('real stats-canon: windows are contiguous, ordered and non-overlapping', () => {
  const w = seasonWindows(CANON, { today: '2026-07-26' });
  assert.ok(w.length >= 79, `expected >= 79 windows, got ${w.length}`);
  for (let i = 1; i < w.length; i++) {
    assert.equal(w[i].start, nextDay(w[i - 1].end), `gap between window ${i - 1} and ${i}`);
    assert.ok(w[i].end > w[i - 1].end, 'windows must advance');
  }
});

test('real stats-canon: winner season labels all resolve to a window', () => {
  const w = seasonWindows(CANON, { today: '2026-07-26' });
  const seasons = [...CANON.bestMusical, ...CANON.bestPlay].map((x) => x.season);
  const unresolved = [...new Set(seasons)].filter((s) => !windowForSeason(w, s));
  assert.deepEqual(unresolved, [], 'every canon season label must map to a window');
});

test('real stats-canon: the 75th Tonys are dated June 2022 via the season label', () => {
  // Guards the upstream off-by-one: A Strange Loop is tagged ceremony 76 in
  // stats-canon.json but won at the 75th (2022-06-12). Joining on the season
  // label must produce the real date, not the 76th's.
  const w = seasonWindows(CANON, { today: '2026-07-26' });
  assert.equal(windowForSeason(w, '2021-22').end, '2022-06-12');
  assert.equal(windowForSeason(w, '2019-20').end, '2021-09-26');
});

test('undated and out-of-range dates resolve to null, never a crash', () => {
  const w = seasonWindows(COVID_CANON, { today: '2022-07-01' });
  assert.equal(seasonForDate(w, null), null);
  assert.equal(seasonForDate(w, undefined), null);
  assert.equal(seasonForDate(w, ''), null);
  assert.equal(seasonForDate(w, '2099-01-01'), null);
  assert.equal(windowForSeason(w, null), null);
  assert.equal(windowForSeason(w, 'not-a-season'), null);
});

test('empty or malformed ceremony data degrades to an empty list', () => {
  assert.deepEqual(seasonWindows({ ceremonies: [] }), []);
  assert.deepEqual(seasonWindows({ ceremonies: [{ ceremony: 1, date: 'garbage' }] }), []);
});
