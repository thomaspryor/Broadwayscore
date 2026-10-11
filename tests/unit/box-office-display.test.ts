/**
 * Box Office v3 market page (BRO-5007): the story sentences, label placement
 * and a real-data sweep of the page object. Imports the real functions (§15).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  closingsSentence,
  cohortSentence,
  moverNote,
  partOfMonth,
  rankJumpSentence,
  seasonPaceSentence,
  shortTitle,
} from '../../src/lib/box-office-display';
import { placeLabels } from '../../src/components/box-office/PriceMap';
import { getBoxOfficeMarketInput, getBoxOfficeMarketPage } from '../../src/lib/data-commercial';
import { historicPace, marketPerSeatByWeek, MOVER_MIN_PCT } from '../../src/lib/box-office-market';

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
  // Historic pace lists every qualifying new show, slow starters included.
  const input = getBoxOfficeMarketInput();
  assert.equal(page.pace.length, historicPace(input, page.week, marketPerSeatByWeek(input)).length);
  // Movers never show a move that rounds to 0%.
  for (const m of [...page.movers.gains, ...page.movers.drops]) assert.ok(Math.abs(m.pct) >= MOVER_MIN_PCT, `${m.title} ${m.pct}`);
});
