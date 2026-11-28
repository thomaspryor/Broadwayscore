// BRO-5804: two confirmed Music Man hiatuses, plus two source omissions that
// still require private-history backfills. See scripts/missing-weeks-audit.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ownRunTotals, fillClearedFromHistory } = require('../../scripts/lib/alltime-attribution');

const NOW = new Date('2026-11-05T00:00:00Z');
const MUSIC_MAN = {
  slug: 'the-music-man-2022', category: 'broadway',
  previewsStartDate: '2021-12-20', closingDate: '2023-01-15',
};
const DARK_WEEKS = ['2022-08-21', '2022-09-11'];
const ROW = { gross: 1_000_000, performances: 8, attendance: 8_000 };

// Build input rows only; all completeness and total calculations use the
// production functions above. These fixtures do not repair private data.
function historyFor(show, first, last, missing = []) {
  // The real archive predates these runs; preserve that boundary for the fill.
  const weeks = { '2001-12-16': {} };
  for (let t = Date.parse(first); t <= Date.parse(last); t += 7 * 86400000) {
    const week = new Date(t).toISOString().slice(0, 10);
    weeks[week] = missing.includes(week) ? {} : { [show.slug]: { ...ROW } };
  }
  return { weeks };
}

function musicHistory(missing = DARK_WEEKS) {
  return historyFor(MUSIC_MAN, '2021-12-26', '2023-01-15', missing);
}

test('Music Man: the two cited dark weeks permit its existing weekly totals to fill', () => {
  const history = musicHistory();
  const own = ownRunTotals(history, MUSIC_MAN, { now: NOW });
  assert.equal(own.gaps, 0);
  assert.equal(own.status, 'complete');
  assert.equal(own.weeks, 54);
  assert.equal(own.gross, 54 * ROW.gross);
  const grosses = {};
  fillClearedFromHistory(grosses, [MUSIC_MAN], history, [], { now: NOW });
  assert.equal(grosses[MUSIC_MAN.slug].allTime.gross, own.gross);
  assert.equal(grosses[MUSIC_MAN.slug].allTimeSource, 'history');
  for (const week of DARK_WEEKS) assert.deepEqual(history.weeks[week], {});
});

for (const week of DARK_WEEKS) {
  test(`Music Man ${week}: the confirmed hiatus is independently exempt`, () => {
    const own = ownRunTotals(musicHistory([week]), MUSIC_MAN, { now: NOW });
    assert.equal(own.gaps, 0);
    assert.equal(own.complete, true);
  });
}

test('a confirmed hiatus cannot hide an unrelated missing Music Man week', () => {
  const history = musicHistory([...DARK_WEEKS, '2022-08-28']);
  const own = ownRunTotals(history, MUSIC_MAN, { now: NOW });
  assert.equal(own.gaps, 1);
  assert.equal(own.status, 'gaps');
  const grosses = {};
  fillClearedFromHistory(grosses, [MUSIC_MAN], history, [], { now: NOW });
  assert.equal(grosses[MUSIC_MAN.slug], undefined);
});

test('a stored zero row is counted once, including legacy Monday week keys', () => {
  for (const key of ['2022-08-21', '2022-08-22']) {
    const history = musicHistory([...DARK_WEEKS, '2022-08-28']);
    history.weeks[key] = { [MUSIC_MAN.slug]: { gross: 0, performances: 0, attendance: 0 } };
    const own = ownRunTotals(history, MUSIC_MAN, { now: NOW });
    assert.equal(own.gaps, 1, key);
    assert.equal(own.weeks, 54, key);
    assert.equal(own.gross, 53 * ROW.gross, key);
  }
});

test('a reported dark-week row with a missing gross remains incomplete', () => {
  const history = musicHistory();
  history.weeks['2022-08-21'][MUSIC_MAN.slug] = { gross: null, performances: 0 };
  assert.equal(ownRunTotals(history, MUSIC_MAN, { now: NOW }).gaps, 1);
});

test('dark weeks outside the observed span cannot cancel earlier holes', () => {
  const history = historyFor(MUSIC_MAN, '2021-12-26', '2022-07-31', ['2022-05-01']);
  const own = ownRunTotals(history, MUSIC_MAN, { now: NOW });
  assert.equal(own.gaps, 1);
  assert.equal(own.complete, false);
});

test('Music Man exceptions do not apply to other productions', () => {
  const show = { ...MUSIC_MAN, slug: 'another-production' };
  const history = historyFor(show, '2021-12-26', '2023-01-15', DARK_WEEKS);
  assert.equal(ownRunTotals(history, show, { now: NOW }).gaps, 2);
});

// League figures published by BroadwayWorld. These were playing weeks, not
// hiatuses. The supplied checkout still lacks both rows; no supported worker
// pending-fix action can edit grosses-history.json. Keep them fail-closed.
const BACKFILLS = [
  {
    show: { slug: 'my-fair-lady-2018', category: 'broadway', previewsStartDate: '2018-03-15', closingDate: '2019-07-07' },
    first: '2018-03-18', week: '2018-03-25',
    // https://www.broadwayworld.com/grosses/MY-FAIR-LADY?year=2018
    // Published as 0 performances + 8 previews; history includes both.
    row: { gross: 934717, attendance: 7797, performances: 8, seatsOffered: 8552, capacity: 91.17, atp: 119.88 },
  },
  {
    show: { slug: 'sunset-boulevard-2017', category: 'broadway', previewsStartDate: '2017-02-02', closingDate: '2017-06-25' },
    first: '2017-02-05', week: '2017-04-02',
    // https://www.broadwayworld.com/grosses/SUNSET-BOULEVARD
    row: { gross: 1206660, attendance: 9427, performances: 7, seatsOffered: 11753, capacity: 80.21, atp: 128 },
  },
];

for (const { show, first, week, row } of BACKFILLS) {
  test(`${show.slug} ${week}: needs a League backfill, never a dark-week exemption`, () => {
    const history = historyFor(show, first, show.closingDate, [week]);
    const before = ownRunTotals(history, show, { now: NOW });
    assert.equal(before.gaps, 1);
    assert.equal(before.complete, false);
    const grosses = {};
    fillClearedFromHistory(grosses, [show], history, [], { now: NOW });
    assert.equal(grosses[show.slug], undefined);

    history.weeks[week][show.slug] = row;
    const after = ownRunTotals(history, show, { now: NOW });
    assert.equal(after.gaps, 0);
    assert.equal(after.complete, true);
    assert.equal(after.gross - before.gross, row.gross);
    fillClearedFromHistory(grosses, [show], history, [], { now: NOW });
    assert.equal(grosses[show.slug].allTime.gross, after.gross);
  });
}
