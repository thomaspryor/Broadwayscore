/**
 * Investment Tracker topic-page aggregates (src/lib/investment-topics.ts,
 * BRO-5865), tested against the real functions (CLAUDE.md §15). Every count a
 * topic page shows comes from these functions, so each has a fixture here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMusicalsSinceReopening,
  bucketOf,
  buildWhatPredictsTheMoney,
  buildFlopsAndRecoups,
  rankWithTies,
  MIN_RATE_SAMPLE,
  formatMillions,
  buildTonyWinners,
  tonyFromAwards,
  inTopicScope,
  musicalKind,
  outcomeOf,
  scoreBand,
  type TopicShowInput,
} from '../../src/lib/investment-topics';

const AS_OF = '2026-10-21';
let n = 0;
const show = (o: Partial<TopicShowInput> & { commercial?: TopicShowInput['commercial'] }): TopicShowInput => ({
  slug: `s${++n}`,
  title: `Show ${n}`,
  type: 'musical',
  isRevival: false,
  tags: [],
  openingDate: '2023-04-01',
  closingDate: null,
  status: 'closed',
  criticScore: null,
  audienceScore: null,
  commercial: { designation: 'Flop', recouped: false },
  ...o,
});

test('scope: commercial, opened since Sep 2021, opened by asOf', () => {
  assert.equal(inTopicScope(show({}), AS_OF), true);
  assert.equal(inTopicScope(show({ openingDate: '2021-08-31' }), AS_OF), false);
  assert.equal(inTopicScope(show({ openingDate: '2021-09-01' }), AS_OF), true);
  assert.equal(inTopicScope(show({ openingDate: '2027-01-01', status: 'upcoming' }), AS_OF), false);
  assert.equal(inTopicScope(show({ status: 'previews' }), AS_OF), false);
  assert.equal(inTopicScope(show({ commercial: null }), AS_OF), false);
  assert.equal(inTopicScope(show({ commercial: { designation: 'Nonprofit', productionType: 'nonprofit' } }), AS_OF), false);
  assert.equal(inTopicScope(show({ commercial: { designation: 'Tour Stop' } }), AS_OF), false);
  // an enhancement deal has investors, so it counts
  assert.equal(inTopicScope(show({ commercial: { designation: 'Nonprofit', productionType: 'enhancement' } }), AS_OF), true);
});

test('musicalKind: jukebox tag is pop-catalog, a revival stays a revival', () => {
  assert.equal(musicalKind({ isRevival: false, tags: ['jukebox'] }), 'pop-catalog');
  assert.equal(musicalKind({ isRevival: true, tags: ['jukebox'] }), 'revival');
  assert.equal(musicalKind({ isRevival: false, tags: ['new'] }), 'original');
  assert.equal(musicalKind({ isRevival: false, tags: null }), 'original');
});

test('outcomeOf: recouped, lost, running, unknown', () => {
  assert.equal(outcomeOf({ status: 'open', commercial: { recouped: true, designation: 'Windfall' } }), 'recouped');
  for (const d of ['Flop', 'Fizzle', 'Did Not Recoup']) assert.equal(outcomeOf({ status: 'closed', commercial: { designation: d } }), 'lost');
  assert.equal(outcomeOf({ status: 'open', commercial: { designation: 'TBD' } }), 'running');
  assert.equal(outcomeOf({ status: 'closed', commercial: { designation: 'TBD' } }), 'unknown');
  // Wait & See (BRO-6499) may still pay back: no verdict yet, never a loss, never in acclaimedLosers.
  assert.equal(outcomeOf({ status: 'closed', commercial: { recouped: false, designation: 'Wait & See' } }), 'unknown');
  assert.equal(outcomeOf({ status: 'closed', commercial: { recouped: true, designation: 'Squeaker' } }), 'recouped');
});

test('musicals since reopening: counts by kind and outcome, plays and pre-reopening excluded', () => {
  const shows = [
    show({ commercial: { designation: 'Windfall', recouped: true, recoupedDate: '2023-09' }, status: 'open' }),
    show({}),
    show({}),
    show({ commercial: { designation: 'TBD', recouped: false }, status: 'open' }),
    show({ commercial: { designation: 'TBD', recouped: false } }),
    show({ tags: ['jukebox'], commercial: { designation: 'Easy Winner', recouped: true, recoupedDate: '2023-06' }, status: 'open' }),
    show({ isRevival: true, commercial: { designation: 'Fizzle', recouped: false } }),
    show({ type: 'play' }),
    show({ openingDate: '2019-03-01' }),
    show({ status: 'upcoming', openingDate: '2027-01-01' }),
  ];
  const r = buildMusicalsSinceReopening(shows, AS_OF);
  assert.equal(r.total, 7);
  assert.equal(r.recouped, 2);
  const by = Object.fromEntries(r.summaries.map((x) => [x.kind, x]));
  assert.deepEqual([by.original.total, by.original.recouped, by.original.lost, by.original.running, by.original.unknown], [5, 1, 2, 1, 1]);
  assert.deepEqual([by['pop-catalog'].total, by['pop-catalog'].recouped], [1, 1]);
  assert.deepEqual([by.revival.total, by.revival.lost], [1, 1]);
  assert.deepEqual([r.originals.total, r.originals.recouped, r.originals.lost], [6, 2, 2]);
  assert.equal(r.summaries.reduce((a, x) => a + x.total, 0), r.total);
});

test('musicals since reopening: months to recoup and the median', () => {
  // medianSample counts only recouped shows with a measurable month
  const r = buildMusicalsSinceReopening([
    show({ openingDate: '2023-01-10', commercial: { designation: 'Windfall', recouped: true, recoupedDate: '2023-07' }, status: 'open' }),
    show({ openingDate: '2023-01-10', commercial: { designation: 'Windfall', recouped: true, recoupedDate: '2024-01' }, status: 'open' }),
    show({ openingDate: '2023-01-10', commercial: { designation: 'Windfall', recouped: true, recoupedDate: null }, status: 'open' }),
  ], AS_OF);
  const months = r.rows.map((x) => x.monthsToRecoup).sort((a, b) => (a ?? 99) - (b ?? 99));
  assert.deepEqual(months, [6, 12, null]);
  assert.equal(r.medianMonthsToRecoup, 9);
  assert.equal(buildMusicalsSinceReopening([], AS_OF).medianMonthsToRecoup, null);
});

test('musicals since reopening: analyst range only on running shows, only when displayed', () => {
  const r = buildMusicalsSinceReopening([
    show({ status: 'open', commercial: { designation: 'TBD', recouped: false, analystRecoupPct: [10, 30] } }),
    show({ status: 'open', commercial: { designation: 'TBD', recouped: false, analystRecoupPct: 'bad' } }),
    show({ status: 'open', commercial: { designation: 'TBD', recouped: false } }),
    show({ status: 'open', commercial: { designation: 'Windfall', recouped: true, analystRecoupPct: [10, 30] } }),
    show({ status: 'open', commercial: { designation: 'TBD', recouped: false, analystRecoupPct: [0, 0] } }),
  ], AS_OF);
  assert.deepEqual(r.rows.map((x) => x.analystRange).filter(Boolean), [[10, 30]]);
});

test('scoreBand edges', () => {
  assert.equal(scoreBand(80), 'high');
  assert.equal(scoreBand(79), 'mid');
  assert.equal(scoreBand(70), 'mid');
  assert.equal(scoreBand(69), 'low');
});

const REC = { designation: 'Windfall', recouped: true, recoupedDate: '2023-06' };
const find = (r: ReturnType<typeof buildWhatPredictsTheMoney>, id: string) => r.buckets.find((b) => b.id === id)!;

test('bucketOf: musical/play by new/revival, other types left out', () => {
  assert.equal(bucketOf({ type: 'musical', isRevival: false }), 'new-musical');
  assert.equal(bucketOf({ type: 'musical', isRevival: true }), 'musical-revival');
  assert.equal(bucketOf({ type: 'play', isRevival: null }), 'new-play');
  assert.equal(bucketOf({ type: 'play', isRevival: true }), 'play-revival');
  assert.equal(bucketOf({ type: 'special', isRevival: false }), null);
});

test('what predicts the money: critic bands per bucket, never pooled; decided = recouped or lost', () => {
  const r = buildWhatPredictsTheMoney([
    show({ criticScore: 85, commercial: REC, status: 'open' }),
    show({ criticScore: 90 }),
    show({ criticScore: 60, commercial: REC }),
    show({ criticScore: 55 }),
    show({ criticScore: 95, commercial: { designation: 'TBD', recouped: false }, status: 'open' }), // running
    show({ criticScore: 99, commercial: { designation: 'TBD', recouped: false } }), // closed, no verdict
    show({ criticScore: null }), // unscored: decided but not banded
    show({ type: 'play', criticScore: 75, commercial: REC }),
    show({ type: 'play', criticScore: 75 }),
    show({ type: 'play', isRevival: true, criticScore: 82 }),
  ], AS_OF);
  const m = find(r, 'new-musical');
  assert.deepEqual(m.critic.high, { recouped: 1, total: 2 });
  assert.deepEqual(m.critic.low, { recouped: 1, total: 2 });
  assert.deepEqual(m.critic.mid, { recouped: 0, total: 0 });
  assert.equal(m.decided, 5);
  assert.equal(m.recouped, 2);
  assert.deepEqual(find(r, 'new-play').critic.mid, { recouped: 1, total: 2 });
  assert.deepEqual(find(r, 'play-revival').critic.high, { recouped: 0, total: 1 });
  assert.equal(find(r, 'musical-revival').decided, 0);
});

test('what predicts the money: audience score split at 70', () => {
  const r = buildWhatPredictsTheMoney([
    show({ type: 'play', audienceScore: 60, commercial: REC }),
    show({ type: 'play', audienceScore: 65 }),
    show({ type: 'play', audienceScore: 70, commercial: REC }),
    show({ audienceScore: 50 }),
    show({ audienceScore: 50 }),
    show({ audienceScore: null }),
  ], AS_OF);
  const p = find(r, 'new-play');
  assert.deepEqual(p.audienceUnder70, { recouped: 1, total: 2 });
  assert.deepEqual(p.audienceAtLeast70, { recouped: 1, total: 1 });
  assert.deepEqual(find(r, 'new-musical').audienceUnder70, { recouped: 0, total: 2 });
});

test('tonyFromAwards: top categories, ceremony not held gives null', () => {
  assert.equal(tonyFromAwards(null), null);
  assert.equal(tonyFromAwards({ season: '2025-26' }), null);
  assert.deepEqual(
    tonyFromAwards({ nominations: 3, nominatedFor: ['Best Musical', 'Best Direction of a Musical', 'Best Choreography'], wins: ['Best Direction of a Musical'] }),
    { nominations: 3, won: true, topNominated: true, topWon: false, season: null, bestNewWon: null },
  );
  assert.deepEqual(
    tonyFromAwards({ nominations: 1, nominatedFor: ['Best Revival of a Play'], wins: ['Best Revival of a Play'] }),
    { nominations: 1, won: true, topNominated: true, topWon: true, season: null, bestNewWon: null },
  );
  assert.deepEqual(tonyFromAwards({ season: '2023-24', nominatedFor: [] }), { nominations: 0, won: false, topNominated: false, topWon: false, season: '2023-24', bestNewWon: null });
  assert.deepEqual(tonyFromAwards({ nominations: 0, nominatedFor: [], wins: [] }), { nominations: 0, won: false, topNominated: false, topWon: false, season: null, bestNewWon: null });
});

test('what predicts the money: Tony splits per bucket, shows without a Tony record left out', () => {
  const t = (nominations: number, won: boolean, topNominated: boolean, topWon: boolean) => ({ nominations, won, topNominated, topWon, season: null, bestNewWon: null });
  const r = buildWhatPredictsTheMoney([
    show({ commercial: REC, tony: t(8, true, true, true) }),
    show({ commercial: REC, tony: t(5, true, true, false) }),
    show({ tony: t(6, false, true, false) }),
    show({ tony: t(2, false, false, false) }),
    show({ tony: t(0, false, false, false) }),
    show({ commercial: REC, tony: null }),
    show({ type: 'play', commercial: REC, tony: t(1, true, false, false) }),
  ], AS_OF);
  const m = find(r, 'new-musical');
  assert.deepEqual(m.tonyNoms.high, { recouped: 2, total: 3 });
  assert.deepEqual(m.tonyNoms.low, { recouped: 0, total: 2 });
  assert.deepEqual(m.tonyWin.won, { recouped: 2, total: 2 });
  assert.deepEqual(m.tonyWin.none, { recouped: 0, total: 3 });
  assert.deepEqual(m.tonyTop.won, { recouped: 1, total: 1 });
  assert.deepEqual(m.tonyTop.nominatedOnly, { recouped: 1, total: 2 });
  assert.deepEqual(m.tonyTop.none, { recouped: 0, total: 2 });
  assert.deepEqual(find(r, 'new-play').tonyWin.won, { recouped: 1, total: 1 });
});

test('what predicts the money: callouts rank low-scored recouped and high-scored losers', () => {
  const rec = { designation: 'Windfall', recouped: true, recoupedDate: '2023-03' };
  const r = buildWhatPredictsTheMoney([
    show({ title: 'Quick Win', type: 'play', openingDate: '2023-01-05', criticScore: 52, commercial: rec, status: 'open' }),
    show({ title: 'Hit', criticScore: 92, commercial: rec, status: 'open' }),
    show({ title: 'Acclaimed Loss', criticScore: 89 }),
    show({ title: 'Lower Loss', criticScore: 70 }),
    show({ title: 'Closed TBD', criticScore: 99, commercial: { designation: 'TBD', recouped: false } }),
  ], AS_OF);
  assert.equal(r.lowScoreRecouped[0].title, 'Quick Win');
  assert.equal(r.lowScoreRecouped[0].score, 52);
  assert.equal(r.lowScoreRecouped[0].weeksToRecoup, 10);
  assert.deepEqual(r.acclaimedLosers.map((x) => x.title), ['Acclaimed Loss', 'Lower Loss']);
  assert.equal(r.acclaimedLosers[0].weeksToRecoup, null);
});

test('tonyFromAwards: Best Musical / Best Play winner and season', () => {
  const a = tonyFromAwards({ season: '2023-24', nominations: 12, nominatedFor: ['Best Musical'], wins: ['Best Musical'] });
  assert.equal(a?.bestNewWon, 'Best Musical');
  assert.equal(a?.season, '2023-24');
  // a revival win is a top-category win but not Best Play / Best Musical
  assert.equal(tonyFromAwards({ season: '2022-23', nominations: 1, nominatedFor: ['Best Revival of a Play'], wins: ['Best Revival of a Play'] })?.bestNewWon, null);
  assert.equal(tonyFromAwards({ season: '2022-23', nominations: 1, nominatedFor: ['Best Play'], wins: ['Best Play'] })?.bestNewWon, 'Best Play');
});

test('flops and recoups: flops ranked by capitalization, loss labels only, unfunded left out', () => {
  const cap = (n: number | null, designation = 'Flop') => ({ designation, recouped: false, capitalization: n });
  const r = buildFlopsAndRecoups([
    show({ title: 'Big Flop', commercial: cap(20_000_000) }),
    show({ title: 'Small Flop', type: 'play', commercial: cap(4_000_000, 'Did Not Recoup') }),
    show({ title: 'Mid Fizzle', commercial: cap(9_000_000, 'Fizzle') }),
    show({ title: 'No Cap', commercial: cap(null) }),
    show({ title: 'Closed TBD', commercial: cap(50_000_000, 'TBD') }), // no verdict: not a flop
    show({ title: 'Running Flop', status: 'open', commercial: cap(60_000_000, 'TBD') }),
    show({ title: 'Old Flop', openingDate: '2019-05-01', commercial: cap(70_000_000) }), // before the reopening
  ], AS_OF);
  assert.deepEqual(r.flops.map((f) => f.title), ['Big Flop', 'Mid Fizzle', 'Small Flop']);
  assert.equal(r.flops[0].capitalization, 20_000_000);
  assert.equal(r.flops[2].type, 'play');
  assert.equal(r.flopsWithoutCapitalization, 1);
});

test('flops and recoups: recoups ranked by weeks, undated recoups counted separately', () => {
  const rec = (date: string | null) => ({ designation: 'Windfall', recouped: true, recoupedDate: date, capitalization: 8_000_000 });
  const r = buildFlopsAndRecoups([
    show({ title: 'Slow', openingDate: '2023-01-05', commercial: rec('2023-12') }),
    show({ title: 'Quick', openingDate: '2023-01-05', commercial: rec('2023-03') }),
    show({ title: 'Undated', openingDate: '2023-01-05', commercial: rec(null) }),
  ], AS_OF);
  assert.deepEqual(r.recoups.map((x) => x.title), ['Quick', 'Slow']);
  assert.equal(r.recoups[0].weeksToRecoup, 10);
  assert.equal(r.recoupsWithoutDate, 1);
});

test('tony winners: Best Musical/Play since 2021-22, commercial only, newest season first', () => {
  const win = (season: string, award: 'Best Musical' | 'Best Play') => ({ nominations: 5, won: true, topNominated: true, topWon: true, season, bestNewWon: award });
  const rec = { designation: 'Windfall', recouped: true, recoupedDate: '2024-01', capitalization: 22_000_000 };
  const r = buildTonyWinners([
    show({ title: 'Old Winner', tony: win('2019-20', 'Best Musical') }),
    show({ title: 'Winner A', openingDate: '2023-04-01', commercial: rec, tony: win('2023-24', 'Best Musical') }),
    show({ title: 'Winner B', tony: win('2021-22', 'Best Play') }),
    show({ title: 'Nonprofit Winner', commercial: { designation: 'Nonprofit', productionType: 'nonprofit' }, tony: win('2023-24', 'Best Play') }),
    show({ title: 'Not A Winner', tony: { nominations: 5, won: false, topNominated: true, topWon: false, season: '2023-24', bestNewWon: null } }),
  ], AS_OF);
  assert.deepEqual(r.rows.map((x) => x.title), ['Winner A', 'Winner B']);
  assert.equal(r.rows[0].outcome, 'recouped');
  assert.equal(r.rows[0].capitalization, 22_000_000);
  assert.equal(r.rows[1].outcome, 'lost');
  assert.equal(r.recouped, 1);
  assert.equal(r.decided, 2);
});

test('formatMillions', () => {
  assert.equal(formatMillions(22_000_000), '$22M');
  assert.equal(formatMillions(22_500_000), '$22.5M');
  assert.equal(formatMillions(4_800_000), '$4.8M');
  assert.equal(formatMillions(5_525_000), '$5.53M');
});

test('rankWithTies: shared ranks, tied rows at the cut-off all stay', () => {
  const rows = [{ n: 'a', v: 9 }, { n: 'b', v: 7 }, { n: 'c', v: 7 }, { n: 'd', v: 7 }, { n: 'e', v: 5 }];
  const r = rankWithTies(rows, (x) => x.v, 3);
  assert.deepEqual(r.map((x) => [x.n, x.rank]), [['a', 1], ['b', 2], ['c', 2], ['d', 2]]);
  assert.deepEqual(rankWithTies(rows, (x) => x.v, 10).map((x) => x.rank), [1, 2, 2, 2, 5]);
  assert.deepEqual(rankWithTies([], (x: { v: number }) => x.v, 3), []);
});

test('flops: capitalization ties share a rank and are not cut alphabetically', () => {
  const cap = (n: number) => ({ designation: 'Flop', recouped: false, capitalization: n });
  const shows = Array.from({ length: 12 }, (_, i) => show({ title: `Tie ${String.fromCharCode(65 + i)}`, commercial: cap(15_000_000) }));
  shows.push(show({ title: 'Top', commercial: cap(30_000_000) }));
  const r = buildFlopsAndRecoups(shows, AS_OF);
  assert.equal(r.flops.length, 13);
  assert.equal(r.flops[0].rank, 1);
  assert.ok(r.flops.slice(1).every((f) => f.rank === 2));
});

test('MIN_RATE_SAMPLE is 5', () => {
  assert.equal(MIN_RATE_SAMPLE, 5);
});

test('recoups: equal weeks share a rank', () => {
  const rec = (d: string) => ({ designation: 'Windfall', recouped: true, recoupedDate: d, capitalization: 8_000_000 });
  const r = buildFlopsAndRecoups([
    show({ title: 'A', openingDate: '2023-01-05', commercial: rec('2023-03') }),
    show({ title: 'B', openingDate: '2023-01-05', commercial: rec('2023-03') }),
    show({ title: 'C', openingDate: '2023-01-05', commercial: rec('2023-12') }),
  ], AS_OF);
  assert.deepEqual(r.recoups.map((x) => x.rank), [1, 1, 3]);
});
