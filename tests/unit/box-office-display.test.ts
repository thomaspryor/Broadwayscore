/**
 * Box Office v3 market page (BRO-5007): the story sentences, label placement
 * and a real-data sweep of the page object. Imports the real functions (§15).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  closingsSentence,
  cohortSentence,
  mapCorners,
  recordText,
  mapOutliers,
  MAP_FULL_PCT,
  moverNote,
  partOfMonth,
  rankJumpSentence,
  seasonPaceSentence,
  shortTitle,
} from '../../src/lib/box-office-display';
import { placeLabels } from '../../src/components/box-office/PriceMap';
import { getBoxOfficeMarketInput, getBoxOfficeMarketPage } from '../../src/lib/data-commercial';
import { MOVER_MIN_PCT } from '../../src/lib/box-office-market';

test('seasonPaceSentence: behind last season but ahead of two back', () => {
  assert.equal(
    seasonPaceSentence('2026-10-04', -5.2, 7.1, '2024-2025'),
    'A soft fall so far. Broadway is running 5% behind last season’s pace but still ahead of 2024–25.',
  );
  assert.equal(
    seasonPaceSentence('2027-01-10', 4, 9, '2024-2025'),
    'A strong winter so far. Broadway is running 4% ahead of last season’s pace and ahead of 2024–25 too.',
  );
  assert.equal(seasonPaceSentence('2026-07-12', 1, 0.5, '2024-2025'), 'A steady summer so far. Broadway is on about the same pace as last season.');
  assert.equal(seasonPaceSentence('2026-10-04', null, 3, '2024-2025'), null, 'no sentence without last season');
});

test('closingsSentence: only when closings explain at least half of a 10%+ drop', () => {
  const two = [{ title: 'Ragtime', gross: 1_600_000 }, { title: 'Salesman', gross: 2_200_000 }];
  assert.equal(
    closingsSentence('2026-07-27', 33_000_000, 27_700_000, two),
    'Most of the drop since late July is two big closings: Salesman ($2.2M a week) and Ragtime ($1.6M).',
  );
  assert.equal(closingsSentence('2026-07-27', 30_000_000, 28_000_000, two), null, 'a 7% dip is not worth explaining');
  assert.equal(closingsSentence('2026-07-27', 33_000_000, 20_000_000, two), null, 'closings explain under half of the drop');
  assert.equal(closingsSentence('2026-07-27', 33_000_000, 27_700_000, []), null);
  assert.match(closingsSentence('2026-08-02', 33_000_000, 29_000_000, [{ title: 'A', gross: 2_500_000 }]) ?? '', /since early August is one big closing: A \(\$2\.5M a week\)/);
});

test('partOfMonth: early, mid, late', () => {
  assert.deepEqual(['2026-08-02', '2026-08-16', '2026-08-30'].map(partOfMonth), ['early August', 'mid-August', 'late August']);
});

test('moverNote: names a schedule change, else capacity', () => {
  const m = { slug: 's', gross: 1, prevGross: 1, pct: 10, capacity: 96.4 };
  assert.equal(moverNote({ ...m, performances: 8, prevPerformances: 8, perShowPct: null }), 'same 8 shows · capacity 96%');
  assert.equal(moverNote({ ...m, performances: 7, prevPerformances: 3, perShowPct: -17.2 }), '7 shows vs 3 last week · per show ▼17%');
  assert.equal(moverNote({ ...m, performances: null, prevPerformances: null, perShowPct: null, capacity: null }), 'same schedule');
});

test('rankJumpSentence: biggest climber in the per-seat top 6, at least 3 places', () => {
  const rows = [{ title: 'A', grossRank: 1 }, { title: 'Oh, Mary!', grossRank: 6 }, { title: 'C', grossRank: 4 }];
  assert.equal(rankJumpSentence(rows), 'Ranked by gross, Oh, Mary! is #6. Per seat, it is #2.');
  assert.equal(rankJumpSentence([{ title: 'A', grossRank: 2 }, { title: 'B', grossRank: 1 }]), null);
});

test('cohortSentence: short titles and plain comparisons', () => {
  assert.equal(
    cohortSentence([{ title: 'Two Strangers (Carry a Cake Across New York)', week: 49, perSeat: 60, typical: 105 }]),
    'In week 49, Two Strangers takes in about $60 a seat, well below the typical new musical still running at that point ($105).',
  );
  assert.match(cohortSentence([{ title: 'X', week: 3, perSeat: 100, typical: 98 }]) ?? '', /about the same as the typical new musical still running/);
  assert.equal(cohortSentence([]), null);
  assert.equal(shortTitle('Back to the Future: The Musical'), 'Back to the Future');
  assert.equal(shortTitle('MJ: The Musical'), 'MJ: The Musical', 'too short a cut keeps the full title');
});

test('placeLabels: no label overlaps another label or a dot; right edge falls back to the left', () => {
  const dots = [
    { slug: 'a', label: 'Hamilton', x: 690, y: 50, r: 10 },
    { slug: 'b', label: 'Wicked', x: 300, y: 200, r: 12 },
    { slug: 'c', label: 'Crowded', x: 300, y: 204, r: 5 },
  ];
  const placed = placeLabels(dots);
  assert.equal(placed.get('a'), 'left', 'a dot at the right edge gets its label on the left');
  assert.equal(placed.get('b'), 'right');
  assert.ok(!placed.has('c'), 'a dot buried under a bigger one stays unlabelled');
});

test('placeLabels: `only` names just those dots, and the others still block labels', () => {
  const dots = [
    { slug: 'big', label: 'Big Show', x: 200, y: 100, r: 12 },
    { slug: 'out', label: 'Outlier', x: 160, y: 100, r: 4 },
  ];
  const placed = placeLabels(dots, undefined, new Set(['out']));
  assert.ok(!placed.has('big'), 'a dot outside `only` gets no label');
  assert.equal(placed.get('out'), 'left', 'the right side is blocked by the unlabelled big dot');
});

test('placeLabels: with vertical, a dot boxed in on both sides gets its label below', () => {
  const dots = [
    { slug: 'mid', label: 'Two Strangers', x: 300, y: 200, r: 5 },
    { slug: 'l', label: 'L', x: 270, y: 200, r: 6 },
    { slug: 'r', label: 'R', x: 330, y: 200, r: 6 },
  ];
  const only = new Set(['mid']);
  assert.ok(!placeLabels(dots, undefined, only).has('mid'), 'sides only: no room');
  assert.equal(placeLabels(dots, undefined, only, true).get('mid'), 'below');
});

test('mapOutliers: the dots farthest from the middle, each axis scaled by its spread', () => {
  const mid = [90, 92, 94, 95, 96].map((c, i) => ({ slug: `m${i}`, capacity: c, atp: 110 + i }));
  const dots = [...mid, { slug: 'pricey', capacity: 100, atp: 280 }, { slug: 'empty', capacity: 62, atp: 70 }];
  assert.deepEqual(Array.from(mapOutliers(dots, 2)).sort(), ['empty', 'pricey']);
  assert.equal(mapOutliers([], 3).size, 0);
});

test('mapCorners: median ticket and the full line split the shows; fullest first; empty corners dropped', () => {
  const dots = [
    { slug: 'a', capacity: 99, atp: 200 },
    { slug: 'b', capacity: MAP_FULL_PCT, atp: 150 },
    { slug: 'c', capacity: 95, atp: 80 },
    { slug: 'd', capacity: 70, atp: 60 },
  ];
  const { medianAtp, corners } = mapCorners(dots);
  assert.equal(medianAtp, 115);
  assert.deepEqual(corners.map((c) => [c.title, c.shows.map((s) => s.slug)]), [
    ['Full and pricey', ['a', 'b']],
    ['Full but cheaper', ['c']],
    ['Lower prices, empty seats', ['d']],
  ]);
  assert.deepEqual(mapCorners([]), { medianAtp: null, corners: [] });
});

test('real data: the market page builds with sane numbers', () => {
  const page = getBoxOfficeMarketPage();
  assert.ok(page, 'market page is null (stale inputs?)');
  assert.ok(page.tiles && page.priceMap.length >= 10, `only ${page.priceMap.length} price-map dots`);
  for (const d of page.priceMap) {
    assert.ok(d.capacity > 20 && d.capacity < 115, `${d.title} capacity ${d.capacity}`);
    assert.ok(d.atp > 20 && d.atp < 600, `${d.title} avg ticket ${d.atp}`);
  }
  for (const r of page.perSeat.rows) assert.ok(r.perSeat > 10 && r.perSeat < 600, `${r.title} per seat ${r.perSeat}`);
  assert.ok(page.cohort.musicals >= 20, `cohort of ${page.cohort.musicals}`);
  if (page.cohort.story) assert.doesNotMatch(page.cohort.story, /\([A-Za-z]/, 'the cohort story uses short titles');
  // Movers never show a move that rounds to 0%.
  for (const m of [...page.movers.gains, ...page.movers.drops]) assert.ok(Math.abs(m.pct) >= MOVER_MIN_PCT, `${m.title} ${m.pct}`);
});

test('recordText: ever, early/mid/late Month within a year, Month YYYY before that', () => {
  const week = '2026-10-04';
  assert.equal(recordText({ ever: true, since: null }, week), 'best week ever');
  assert.equal(recordText({ ever: false, since: '2026-01-04' }, week), 'best week since early January');
  assert.equal(recordText({ ever: false, since: '2026-03-15' }, week), 'best week since mid-March');
  assert.equal(recordText({ ever: false, since: '2025-09-28' }, week), 'best week since September 2025');
  // The same week a year back never reads like last week.
  assert.equal(recordText({ ever: false, since: '2024-12-29' }, '2025-12-28'), 'best week since December 2024');
});

test('real data: the personal-bests card lists at most six, with the rest counted', () => {
  const page = getBoxOfficeMarketPage()!;
  assert.ok(page.records.rows.length <= 6);
  if (page.records.more > 0) assert.equal(page.records.rows.length, 6);
  for (const r of page.records.rows) assert.match(r.text, /^best week (ever|since )/);
});
