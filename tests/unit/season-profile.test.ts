/**
 * Season profile for the commercial scorecard (src/lib/season-profile.ts),
 * tested against the real functions (CLAUDE.md §15). Runs in the tsx batch
 * (tests/unit-test-manifest-tsx.txt).
 *
 *  - mix shares (musicals, revivals within each bucket) count only known flags
 *  - nonprofits and tour stops leave the recoupment and capital denominators
 *  - money rows skip seasons without enough disclosed capitalizations
 *  - an empty season (2020-21) is skipped, not averaged in as zero
 *  - an in-progress season gets an "Opened so far" row compared at the same day
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRecoupFindings,
  buildSeasonProfiles,
  compareSeason,
  formatRowValue,
  hasReturnedCoverage,
  returnedCapitalShare,
  isOwnEstimate,
  mix,
  MIX_ROW_LABELS_HIDDEN,
  seasonBaseline,
  seasonHistoryAverage,
  showGroup,
  trackedRecord,
  type SeasonShowInput,
} from '../../src/lib/season-profile';

const show = (o: Partial<SeasonShowInput> & { openingDate: string }): SeasonShowInput => ({
  type: 'play',
  isRevival: false,
  commercial: null,
  ...o,
});
const com = (o: NonNullable<SeasonShowInput['commercial']> = {}) => ({ designation: 'TBD', ...o });

test('mix shares count musicals, plays and revivals within each bucket', () => {
  const [p] = buildSeasonProfiles([
    show({ openingDate: '2024-10-01', type: 'musical', isRevival: true }),
    show({ openingDate: '2024-11-01', type: 'musical', isRevival: false }),
    show({ openingDate: '2025-01-01', type: 'play', isRevival: true }),
    show({ openingDate: '2025-02-01', type: 'play', isRevival: undefined }),
    show({ openingDate: '2025-03-01', type: 'special', isRevival: false }),
  ]);
  assert.equal(p.season, '2024-2025');
  assert.equal(p.productions, 5);
  assert.deepEqual([p.musicals, p.plays, p.other], [2, 2, 1]);
  assert.deepEqual([p.revivals, p.revivalKnown], [2, 4]);
  assert.deepEqual([p.musicalRevivals, p.musicalRevivalKnown], [1, 2]);
  assert.deepEqual([p.playRevivals, p.playRevivalKnown], [1, 1]);
});

test('nonprofits and tour stops leave recoupment and capital; enhancement deals stay', () => {
  // nonprofit counts producing nonprofits (enhancement included), never tour stops.
  const [p] = buildSeasonProfiles([
    show({ openingDate: '2024-10-01', commercial: com({ designation: 'Nonprofit', nonprofitOrg: 'MTC', capitalization: 9e6 }) }),
    show({ openingDate: '2024-10-02', commercial: com({ designation: 'Tour Stop' }) }),
    show({ openingDate: '2024-10-03', commercial: com({ designation: 'Nonprofit', nonprofitOrg: 'LCT', productionType: 'enhancement', capitalization: 4e6 }) }),
    show({ openingDate: '2024-10-04', commercial: com({ recouped: true, capitalization: 6e6, weeklyCost: 500000 }) }),
    show({ openingDate: '2024-10-05', type: 'musical', commercial: com({ capitalization: null }) }),
  ]);
  assert.deepEqual([p.tracked, p.nonprofit, p.commercial, p.recouped], [5, 2, 3, 1]);
  assert.deepEqual(p.capitalization.all, { known: 2, of: 3, total: 10e6 });
  assert.deepEqual(p.capitalization.musical, { known: 0, of: 1, total: 0 });
  assert.deepEqual(p.runningCost.play, { known: 1, of: 2, total: 500000 });
});

function season(startYear: number, n: number, opts: { musicals?: number; tracked?: boolean; cap?: number | null } = {}): SeasonShowInput[] {
  const out: SeasonShowInput[] = [];
  for (let i = 0; i < n; i++) {
    out.push(show({
      openingDate: `${startYear}-${String(8 + (i % 4)).padStart(2, '0')}-1${i % 9}`,
      type: i < (opts.musicals ?? 0) ? 'musical' : 'play',
      commercial: opts.tracked ? com({ capitalization: opts.cap === undefined ? 5e6 : opts.cap, recouped: i === 0 }) : null,
    }));
  }
  return out;
}

test('baseline skips pandemic seasons; money rows need their own coverage', () => {
  const shows = [
    ...season(2025, 10, { musicals: 5, tracked: true, cap: 8e6 }),
    ...season(2024, 10, { musicals: 2, tracked: true, cap: 4e6 }),
    ...season(2023, 10, { musicals: 2, tracked: true, cap: 6e6 }),
    // 2022-23 tracked but no capitalization disclosed: in the mix, out of money rows.
    ...season(2022, 10, { musicals: 2, tracked: true, cap: null }),
    // 2019-20 (shutdown) is left out of the baseline; 2020-21 had no openings.
    ...season(2019, 10, { musicals: 9 }),
  ];
  const cmp = compareSeason(buildSeasonProfiles(shows), '2025-2026', '2026-09-01');
  assert.ok(cmp);
  assert.equal(cmp.inProgress, false);
  assert.equal(cmp.lastSeason, '2024-2025');
  assert.deepEqual(cmp.baselineRange, ['2022-2023', '2024-2025']);
  const row = (label: string) => cmp.rows.find((r) => r.label === label)!;

  assert.equal(row('New productions').avg, 10);
  assert.equal(row('Musicals').current, 0.5);
  assert.equal(row('Musicals').currentDetail, '5 of 10');
  assert.equal(row('Musicals').last, 0.2);
  // The third column is the season before last (owner, 2026-10-26).
  assert.equal(cmp.prevSeason, '2023-2024');
  assert.equal(row('Musicals').prev, 0.2);
  assert.equal(row('Musicals').prevDetail, '2 of 10');
  assert.equal(row('Disclosed capitalization (sum)').prev, 60e6);
  assert.equal(row('Musicals').avg, 6 / 30); // pooled 2+2+2 of 30; 2019-20's 9 musicals excluded

  // 2025-26 ended Jul 2026: still settling, so labelled "so far". All three
  // baseline seasons ended over a year before Sep 2026: settled.
  assert.equal(cmp.recoupUnsettled, true);
  assert.equal(cmp.baselineSeasons, 3);
  assert.equal(row('Commercial shows recouped as of today').avgSeasons, 3);
  assert.equal(row('Commercial shows recouped as of today').avg, 3 / 30);

  // Only 2024-25 and 2023-24 have disclosed capitalizations.
  const cap = row('Average capitalization, play');
  assert.equal(cap.current, 8e6);
  assert.equal(cap.avgSeasons, 2);
  assert.equal(cap.avg, 5e6);
  // No running costs anywhere: gated on that field, not on capitalization.
  assert.equal(row('Average weekly running cost, play').current, null);
  assert.equal(row('Average weekly running cost, play').avgSeasons, 0);

  const sum = row('Disclosed capitalization (sum)');
  assert.deepEqual([sum.current, sum.currentDetail, sum.last, sum.avg, sum.avgSeasons], [80e6, '10 of 10 disclosed', 40e6, 50e6, 2]);
});

test('capitalization sums are stated for every season with what was disclosed (owner, 2026-10-21)', () => {
  const shows = [
    // 2025-26: 6 of 10 disclosed (60%): stated, with its disclosure count.
    ...season(2025, 10, { tracked: true, cap: 5e6 }).map((s, i) => (i < 4 ? { ...s, commercial: com({ capitalization: null }) } : s)),
    ...season(2024, 10, { tracked: true, cap: 4e6 }),
  ];
  const cmp = compareSeason(buildSeasonProfiles(shows), '2025-2026', '2026-09-01')!;
  const sum = cmp.rows.find((r) => r.label === 'Disclosed capitalization (sum)')!;
  assert.deepEqual([sum.current, sum.currentDetail, sum.last, sum.lastDetail, sum.avg, sum.avgDetail, sum.avgSeasons],
    [30e6, '6 of 10 disclosed', 40e6, '10 of 10 disclosed', 40e6, '10 of 10 disclosed', 1]);
});

test('recoupment average leaves out seasons still playing out', () => {
  const shows = [
    ...season(2026, 5, { tracked: true }),
    ...season(2025, 10, { tracked: true }), // ended Jul 2026: not settled by Oct 2026
    ...season(2024, 10, { tracked: true }),
  ];
  const cmp = compareSeason(buildSeasonProfiles(shows), '2026-2027', '2026-10-20')!;
  const r = cmp.rows.find((x) => x.label === 'Commercial shows recouped as of today')!;
  assert.equal(r.last, 0.1); // last season is still shown
  assert.equal(r.avgSeasons, 1); // but only 2024-25 is averaged
});

test('a closed show with only a research placeholder is untracked; a TBD show with facts still counts', () => {
  assert.equal(trackedRecord({ status: 'closed', commercial: com() }), null);
  assert.deepEqual(trackedRecord({ status: 'open', commercial: com() }), com()); // running: not recouped yet
  assert.deepEqual(trackedRecord({ status: 'closed', commercial: com({ designation: 'Flop' }) }), com({ designation: 'Flop' }));
  assert.deepEqual(trackedRecord({ status: 'closed', commercial: com({ recouped: false }) }), com({ recouped: false }));
  assert.deepEqual(trackedRecord({ status: 'closed', commercial: com({ capitalization: 5e6 }) }), com({ capitalization: 5e6 }));
  assert.deepEqual(trackedRecord({ status: 'closed', commercial: com({ sources: ['x'] }) }), com({ sources: ['x'] }));
  const shows = [
    show({ openingDate: '2016-01-10', status: 'closed', commercial: com({ designation: 'Easy Winner', recouped: true }) }),
    show({ openingDate: '2016-02-10', status: 'closed', commercial: com() }),
    show({ openingDate: '2016-03-10', status: 'closed', commercial: com() }),
    show({ openingDate: '2016-04-10', status: 'open', commercial: com() }),
  ];
  const p = buildSeasonProfiles(shows).find((x) => x.season === '2015-2016')!;
  assert.equal(p.productions, 4);
  assert.equal(p.tracked, 2); // the two closed placeholders are unknown, not "did not recoup"
  assert.equal(p.commercial, 2);
  assert.equal(p.recouped, 1);
  // 2 of 4 tracked is under MIN_TRACKED_SHARE: placeholders no longer make the season count for who-recoups.
  const f = buildRecoupFindings(shows.map((x) => ({ ...x, status: x.status ?? null, criticScore: null })), '2026-10-20');
  assert.equal(f.buckets.find((b) => b.label === 'Original plays')!.total, 0);
  assert.equal(f.range, null);
});

test('an in-progress season compares openings at the same point in the season', () => {
  const shows = [
    show({ openingDate: '2026-08-25' }),
    show({ openingDate: '2026-09-28' }),
    show({ openingDate: '2027-04-12', type: 'musical' }),
    show({ openingDate: '2025-08-01' }),
    show({ openingDate: '2025-10-30' }), // after Oct 20 last season
    show({ openingDate: '2026-04-01' }),
  ];
  const cmp = compareSeason(buildSeasonProfiles(shows), '2026-2027', '2026-10-20');
  assert.ok(cmp);
  assert.equal(cmp.inProgress, true);
  const opened = cmp.rows[0];
  assert.equal(opened.label, 'Opened so far');
  assert.deepEqual([opened.current, opened.last], [2, 1]);
  assert.equal(cmp.rows[1].label, 'Productions (opened + announced)');
  assert.equal(cmp.rows[1].current, 3);
});

test('unknown season returns null; formatting', () => {
  assert.equal(compareSeason([], '2024-2025', '2026-01-01'), null);
  assert.equal(formatRowValue('pct', 0.375), '38%');
  assert.equal(formatRowValue('money', 14_250_000), '$14.3M');
  assert.equal(formatRowValue('money', 480_577), '$481K');
  assert.equal(formatRowValue('count', 31.25), '31.3');
  assert.equal(formatRowValue('count', null), '—');
});

test('a per-show average needs MIN_AVERAGE_SAMPLE disclosed figures', () => {
  const two = [
    show({ openingDate: '2024-10-01', commercial: com({ capitalization: 7e6 }) }),
    show({ openingDate: '2024-10-02', commercial: com({ capitalization: 8e6 }) }),
  ];
  const cmp = compareSeason(buildSeasonProfiles(two), '2024-2025', '2026-01-01')!;
  const row = cmp.rows.find((r) => r.label === 'Average capitalization, play')!;
  assert.equal(row.current, null);
  assert.equal(row.currentDetail, '2 of 2 disclosed');
  // The total is a sum, not an average: still shown.
  assert.equal(cmp.rows.find((r) => r.label === 'Disclosed capitalization (sum)')!.current, 15e6);
  const three = [...two, show({ openingDate: '2024-10-03', commercial: com({ capitalization: 9e6 }) })];
  assert.equal(compareSeason(buildSeasonProfiles(three), '2024-2025', '2026-01-01')!.rows.find((r) => r.label === 'Average capitalization, play')!.current, 8e6);
});

test('a season under way: averages state what is disclosed, counted against the whole announced slate', () => {
  const shows = [
    // 2026-27: 6 musicals announced, only 3 in commercial.json, all disclosed.
    ...[0, 1, 2].map((i) => show({ openingDate: `2026-1${i}-01`, type: 'musical', commercial: com({ capitalization: 20e6 }) })),
    ...[0, 1, 2].map((i) => show({ openingDate: `2027-0${i + 1}-15`, type: 'musical' })),
    ...season(2025, 10, { musicals: 10, tracked: true, cap: 15e6 }),
  ];
  const cmp = compareSeason(buildSeasonProfiles(shows), '2026-2027', '2026-10-20')!;
  const row = (label: string) => cmp.rows.find((r) => r.label === label)!;
  const avg = row('Average capitalization, musical');
  assert.deepEqual([avg.current, avg.currentDetail, avg.last, avg.lastDetail], [20e6, '3 of 6 disclosed', 15e6, '10 of 10 disclosed']);
  const sum = row('Disclosed capitalization (sum)');
  assert.deepEqual([sum.current, sum.last], [60e6, 150e6]);
});

test('shares of fewer than 3 shows are not stated; a disrupted last season still fills its column', () => {
  const shows = [
    show({ openingDate: '2021-10-01', commercial: com({ recouped: true }) }),
    show({ openingDate: '2021-10-02', commercial: com({}) }),
    ...season(2019, 5, { tracked: true }),
  ];
  const cmp = compareSeason(buildSeasonProfiles(shows), '2021-2022', '2026-10-20')!;
  const recoup = cmp.rows.find((r) => r.label === 'Commercial shows recouped')!;
  assert.equal(recoup.current, null); // 1 of 2 is not a rate
  assert.equal(recoup.currentDetail, '1 of 2');
  assert.equal(cmp.lastSeason, '2019-2020');
  assert.equal(cmp.lastDisrupted, true);
  assert.equal(cmp.prevSeason, null); // nothing opened before 2019-20 in this fixture
  assert.equal(recoup.prev, null);
  assert.equal(cmp.baselineSeasons, 0);
  assert.equal(recoup.last, 0.2);
});

test('who recoups: buckets over finished, well-tracked seasons; critic bands over decided shows', () => {
  const r = (o: Partial<Parameters<typeof buildRecoupFindings>[0][number]> & { openingDate: string }) => ({
    type: 'play', isRevival: false, status: 'closed', criticScore: 70, commercial: com({ recouped: false }), ...o,
  });
  const shows = [
    r({ openingDate: '2024-10-01', isRevival: true, commercial: com({ recouped: true }), criticScore: 85 }),
    r({ openingDate: '2024-10-02', isRevival: true, criticScore: 82 }),
    r({ openingDate: '2024-10-03', type: 'musical', criticScore: 55 }),
    r({ openingDate: '2024-10-04', type: 'musical', status: 'open', criticScore: 50 }), // undecided: in bucket, not in bands
    r({ openingDate: '2024-10-05', commercial: com({ designation: 'Nonprofit' }) }), // no investors: out
    r({ openingDate: '2024-10-06', commercial: com({ recouped: true }), criticScore: 90 }),
    // 2026-27 is under way and 2025-26 ended under a year ago on 2026-10-20: both left out.
    r({ openingDate: '2026-09-01', commercial: com({ recouped: true }), criticScore: 99 }),
    r({ openingDate: '2025-09-01', commercial: com({ recouped: true }), criticScore: 99 }),
  ];
  const f = buildRecoupFindings(shows, '2026-10-20');
  assert.deepEqual(f.range, ['2024-2025', '2024-2025']);
  const b = Object.fromEntries(f.buckets.map((x) => [x.label, [x.recouped, x.total]]));
  assert.deepEqual(b, { 'Play revivals': [1, 2], 'Original plays': [1, 1], 'Musical revivals': [0, 0], 'Original musicals': [0, 2] });
  assert.deepEqual(f.under60, { recouped: 0, total: 1 });
  assert.deepEqual(f.atLeast80, { recouped: 2, total: 3 });
  assert.equal(f.recoupedScored, 2);
  assert.equal(f.recoupedAvgScore, null); // 2 scores: under MIN_AVERAGE_SAMPLE
  assert.equal(f.closedUnrecoupedScored, 2);
});

test('2x2 mix: originals and revivals each split into musicals vs plays; pooled across seasons', () => {
  const ps = buildSeasonProfiles([
    show({ openingDate: '2024-10-01', type: 'musical', isRevival: false }),
    show({ openingDate: '2024-10-02', type: 'musical', isRevival: true }),
    show({ openingDate: '2024-10-03', type: 'play', isRevival: true }),
    show({ openingDate: '2024-10-04', type: 'play', isRevival: true }),
    show({ openingDate: '2024-10-05', type: 'play', isRevival: false }),
    show({ openingDate: '2024-10-06', type: 'special', isRevival: false }),
    show({ openingDate: '2023-10-01', type: 'musical', isRevival: false }),
  ]);
  const [y25, y24] = ps;
  assert.deepEqual(mix(y25), { originalMusicals: 1, musicalRevivals: 1, originalPlays: 1, playRevivals: 2, other: 1, total: 6 });
  assert.equal(mix(y25, y24).originalMusicals, 2);
  const cmp = compareSeason(ps, '2024-2025', '2026-01-01')!;
  const row = (l: string) => cmp.rows.find((r) => r.label === l)!;
  assert.equal(row('Musicals among originals').current, 0.5);
  assert.equal(row('Musicals among originals').currentDetail, '1 of 2');
  assert.equal(row('Musicals among revivals').current, 1 / 3);
  assert.equal(row('Musicals among originals').last, 1);
  assert.deepEqual(seasonBaseline(ps, '2024-2025').baseline.map((p) => p.season), ['2023-2024']);
});

test('every mix row label the report relies on is a real compareSeason row', () => {
  const ps = buildSeasonProfiles([show({ openingDate: '2024-10-01' }), show({ openingDate: '2023-10-01' })]);
  const labels = new Set(compareSeason(ps, '2024-2025', '2026-01-01')!.rows.map((r) => r.label));
  for (const l of MIX_ROW_LABELS_HIDDEN) assert.ok(labels.has(l), `compareSeason has no '${l}' row`);
});

// Owner 2026-10-21: a season's capital total should not just track how many budgets are public.
test('estimated capital adds a median of similar disclosed shows for each undisclosed one', () => {
  const ps = buildSeasonProfiles([
    // Disclosed original musicals around 2023: median 15M.
    show({ openingDate: '2022-10-01', type: 'musical', commercial: com({ capitalization: 10e6 }) }),
    show({ openingDate: '2023-10-01', type: 'musical', commercial: com({ capitalization: 15e6 }) }),
    show({ openingDate: '2024-10-01', type: 'musical', commercial: com({ capitalization: 30e6 }) }),
    // A disclosed revival never sizes an original.
    show({ openingDate: '2023-11-01', type: 'musical', isRevival: true, commercial: com({ capitalization: 90e6 }) }),
    show({ openingDate: '2023-12-01', type: 'musical', commercial: com({ capitalization: null }) }),
    // Nonprofit runs have no investors: neither counted nor estimated.
    show({ openingDate: '2023-12-02', type: 'musical', commercial: com({ designation: 'Nonprofit', nonprofitOrg: 'MTC' }) }),
  ]);
  const p = ps.find((x) => x.season === '2023-2024')!;
  assert.equal(p.capitalization.all.total, 105e6);
  assert.deepEqual(p.estimatedCapital, { total: 120e6, estimated: 1, missing: 0, nonprofitOut: 0 });
});

// BRO-5647: six budgets we estimated ourselves (isEstimate / "Estimate:" source)
// were counted as disclosed. Our estimate fills the estimated total, never the
// disclosed sum, the disclosed averages or the comparables pool.
test('our own capitalization estimate is not a disclosed figure', () => {
  const ps = buildSeasonProfiles([
    show({ openingDate: '2022-10-01', type: 'musical', commercial: com({ capitalization: 10e6 }) }),
    show({ openingDate: '2023-10-01', type: 'musical', commercial: com({ capitalization: 20e6 }) }),
    show({ openingDate: '2024-10-01', type: 'musical', commercial: com({ capitalization: 30e6 }) }),
    // Our estimate of 90M: kept out of the pool, so the median stays 20M.
    show({ openingDate: '2023-11-01', type: 'musical', commercial: com({ capitalization: 90e6, isEstimate: { capitalization: true } }) }),
    show({ openingDate: '2023-12-01', type: 'musical', commercial: com({ capitalization: null }) }),
  ]);
  const p = ps.find((x) => x.season === '2023-2024')!;
  assert.equal(p.capitalization.all.total, 20e6);
  assert.equal(p.capitalization.all.known, 1);
  assert.equal(p.capitalization.musical.known, 1);
  assert.deepEqual(p.estimatedCapital, { total: 20e6 + 90e6 + 20e6, estimated: 2, missing: 0, nonprofitOut: 0 });
  // An "Estimate:" source alone marks it too.
  const [q] = buildSeasonProfiles([show({ openingDate: '2023-11-01', type: 'musical',
    commercial: com({ capitalization: 5e6, capitalizationSource: 'Estimate: about 2.6 times its tax credit' }) })]);
  assert.equal(q.capitalization.all.known, 0);
  assert.deepEqual(q.estimatedCapital, { total: 5e6, estimated: 1, missing: 0, nonprofitOut: 0 });
  // getSeasonStats (the /biz capital cards) uses the same test.
  assert.equal(isOwnEstimate({ capitalization: 5e6, capitalizationSource: 'Estimate: comparables' }), true);
  assert.equal(isOwnEstimate({ capitalization: 5e6, isEstimate: { capitalization: true } }), true);
  // An uncited figure is not ours: it stays disclosed (shown with "~").
  assert.equal(isOwnEstimate({ capitalization: 5e6, capitalizationSource: null }), false);
  assert.equal(isOwnEstimate({ capitalization: null, isEstimate: { capitalization: true } }), false);
});

test('estimated capital widens the window, then drops the revival match, then gives up', () => {
  const plays = (year: number, caps: number[], isRevival = false) =>
    caps.map((c, i) => show({ openingDate: `${year}-0${i + 1}-15`, isRevival, commercial: com({ capitalization: c }) }));
  // Revival plays only 4 seasons away: the 2-season window has none, the 4-season one has 3.
  const widened = buildSeasonProfiles([...plays(2016, [2e6, 4e6, 6e6], true),
    show({ openingDate: '2019-10-01', isRevival: true, commercial: com() })]);
  assert.equal(widened.find((x) => x.season === '2019-2020')!.estimatedCapital.total, 4e6);
  // No revival plays at all: originals of the same type stand in.
  const anyRevival = buildSeasonProfiles([...plays(2019, [1e6, 3e6, 5e6]),
    show({ openingDate: '2019-10-01', isRevival: true, commercial: com() })]);
  assert.equal(anyRevival.find((x) => x.season === '2019-2020')!.estimatedCapital.estimated, 1);
  // Too few comparable shows: counted as missing, not guessed.
  const [lone] = buildSeasonProfiles([show({ openingDate: '2019-10-01', commercial: com() })]);
  assert.deepEqual(lone.estimatedCapital, { total: 0, estimated: 0, missing: 1, nonprofitOut: 0 });
});

test('the history average leaves out the season under way and the pandemic seasons', () => {
  const ps = buildSeasonProfiles([
    ...season(2021, 10, { musicals: 5, tracked: true }),
    ...season(2022, 20, { musicals: 5, tracked: true }),
    ...season(2019, 4, { tracked: true }),
    ...season(2026, 30, { musicals: 30, tracked: true }),
  ]);
  const avg = seasonHistoryAverage(ps, '2026-2027', '2026-10-21');
  assert.equal(avg.seasons, 2);
  assert.equal(avg.productions, 15);
  assert.equal(avg.musicals.share, 10 / 30);
  // Both seasons ended over a year before the as-of date, so both count toward recoupment.
  assert.deepEqual(avg.recouped, { recouped: 1, commercial: 15, seasons: 2 });
  assert.deepEqual(avg.estimatedCapital, { avg: 75e6, seasons: 2 });
});

test('nonprofit-presented runs are neither estimated nor used to estimate', () => {
  const ps = buildSeasonProfiles([
    show({ openingDate: '2023-10-01', commercial: com({ capitalization: 4e6 }) }),
    show({ openingDate: '2023-10-02', commercial: com({ capitalization: 6e6 }) }),
    show({ openingDate: '2023-10-03', commercial: com({ capitalization: 8e6 }) }),
    // An enhancement deal's small disclosed figure stays out of the commercial pool.
    show({ openingDate: '2023-10-04', commercial: com({ nonprofitOrg: 'MTC', productionType: 'enhancement', capitalization: 1e5 }) }),
    show({ openingDate: '2023-10-05', commercial: com({ nonprofitOrg: 'LCT', productionType: 'enhancement' }) }),
    show({ openingDate: '2023-10-06', commercial: com() }),
  ]);
  assert.deepEqual(ps[0].estimatedCapital, { total: 18.1e6 + 6e6, estimated: 1, missing: 0, nonprofitOut: 1 });
});

test('every column carries its counts: last season as "n of d", the average per season', () => {
  const shows = [
    ...season(2026, 4, { musicals: 2 }),
    ...season(2025, 10, { musicals: 4 }),
    ...season(2024, 10, { musicals: 6 }),
    ...season(2023, 20, { musicals: 6 }),
  ];
  const cmp = compareSeason(buildSeasonProfiles(shows), '2026-2027', '2026-10-20')!;
  const m = cmp.rows.find((r) => r.label === 'Musicals')!;
  assert.deepEqual([m.currentDetail, m.lastDetail, m.avgDetail], ['2 of 4', '4 of 10', '5.3 of 13.3']);
});

test('showGroup puts each show in the same group mix() counts it in', () => {
  assert.equal(showGroup('musical', false), 'original-musicals');
  assert.equal(showGroup('musical', true), 'musical-revivals');
  assert.equal(showGroup('play', false), 'original-plays');
  assert.equal(showGroup('play', true), 'play-revivals');
  assert.equal(showGroup('special', false), 'specials');
  assert.equal(showGroup('play', undefined), 'specials');
  const shows = [
    show({ openingDate: '2022-10-01', type: 'musical', isRevival: true }),
    show({ openingDate: '2022-10-02', type: 'play', isRevival: false }),
    show({ openingDate: '2022-10-03', type: 'play', isRevival: null }),
  ];
  const m = mix(...buildSeasonProfiles(shows));
  const count = (id: string) => shows.filter((s) => showGroup(s.type, s.isRevival) === id).length;
  assert.deepEqual([m.musicalRevivals, m.originalPlays, m.other], [count('musical-revivals'), count('original-plays'), count('specials')]);
});

test('recouped show names are listed per bucket; shows that did not recoup are not', () => {
  const shows = [
    { ...show({ openingDate: '2022-10-01', type: 'play', isRevival: true, commercial: com({ recouped: true }) }), status: 'closed', criticScore: 80, slug: 'b-show', title: 'B Show' },
    { ...show({ openingDate: '2022-10-02', type: 'play', isRevival: true, commercial: com({ recouped: true }) }), status: 'closed', criticScore: 80, slug: 'a-show', title: 'A Show' },
    { ...show({ openingDate: '2022-10-03', type: 'play', isRevival: true, commercial: com({ recouped: false }) }), status: 'closed', criticScore: 40, slug: 'flop', title: 'Flop' },
  ];
  const f = buildRecoupFindings(shows, '2026-10-20');
  const pr = f.buckets.find((b) => b.label === 'Play revivals')!;
  assert.deepEqual(pr.recoupedShows.map((s) => s.title), ['A Show', 'B Show']);
});

test('capital by outcome: closed-unrecouped and running shows, same per-show figures as the estimated total', () => {
  const shows = [
    show({ openingDate: '2025-10-01', status: 'closed', commercial: com({ capitalization: 10e6, recouped: false }) }),
    show({ openingDate: '2025-10-02', status: 'closed', commercial: com({ capitalization: 6e6, recouped: true }) }),
    show({ openingDate: '2025-10-03', status: 'open', commercial: com({ capitalization: 4e6, recouped: false }) }),
    show({ openingDate: '2025-10-04', status: 'open', commercial: com({ capitalization: 3e6, recouped: true }) }),
  ];
  const p = buildSeasonProfiles(shows).find((x) => x.season === '2025-2026')!;
  assert.equal(p.estimatedCapital.total, 23e6);
  assert.deepEqual(p.capitalByOutcome, { closedUnrecouped: 10e6, closedUnrecoupedShows: 1, running: 4e6, runningShows: 1 });
});

test('returned capital share: recouped, closed estimate, model and unopened cases (BRO-6335)', () => {
  const cited = [{ url: 'https://example.com/a' }];
  // Recouped: reported multiple only with a cited source, else 100%.
  assert.deepEqual(returnedCapitalShare(com({ recouped: true, investorMultiple: 2.5, sources: cited }), 'open'), { low: 2.5, mid: 2.5, high: 2.5 });
  assert.deepEqual(returnedCapitalShare(com({ recouped: true, investorMultiple: 2.5 }), 'open'), { low: 1, mid: 1, high: 1 });
  assert.deepEqual(returnedCapitalShare(com({ recouped: true }), 'closed'), { low: 1, mid: 1, high: 1 });
  // Closed, unrecouped: own estimate range first, then the model.
  assert.deepEqual(returnedCapitalShare(com({ recouped: false, ourEstimateRangePct: [20, 40], modelReturnedExCreditPct: [0, 5, 10] }), 'closed'), { low: 0.2, mid: 0.3, high: 0.4 });
  assert.deepEqual(returnedCapitalShare(com({ recouped: false, modelReturnedExCreditPct: [10, 30, 50] }), 'closed'), { low: 0.1, mid: 0.3, high: 0.5 });
  assert.deepEqual(returnedCapitalShare(com({ recouped: false, modelRecoupmentPctV2: [-20, 30, 160] }), 'closed'), { low: 0, mid: 0.3, high: 1 });
  // Running: the model, never the closed-show estimate.
  assert.deepEqual(returnedCapitalShare(com({ recouped: false, ourEstimateRangePct: [90, 95], modelRecoupmentPct: [10, 20, 30] }), 'open'), { low: 0.1, mid: 0.2, high: 0.3 });
  // No basis, or not open yet: nothing.
  assert.equal(returnedCapitalShare(com({ recouped: false }), 'closed'), null);
  assert.equal(returnedCapitalShare(com({ recouped: false, modelRecoupmentPct: [10, 20, 30] }), 'announced'), null);
});

test('returned capital: sums capital x share per show with a low-high band, skipping shows with no basis', () => {
  const shows = [
    show({ openingDate: '2025-10-01', status: 'closed', commercial: com({ capitalization: 10e6, recouped: false, ourEstimateRangePct: [20, 40] }) }),
    show({ openingDate: '2025-10-02', status: 'closed', commercial: com({ capitalization: 6e6, recouped: true }) }),
    show({ openingDate: '2025-10-03', status: 'open', commercial: com({ capitalization: 4e6, recouped: false, modelRecoupmentPct: [0, 50, 100] }) }),
    // Capital but no returned estimate: counted in `of`, not in `shows` or the capital base.
    show({ openingDate: '2025-10-04', status: 'open', commercial: com({ capitalization: 5e6, recouped: false }) }),
  ];
  const p = buildSeasonProfiles(shows).find((x) => x.season === '2025-2026')!;
  assert.deepEqual(p.returnedCapital, { capital: 20e6, low: 2e6 + 6e6, mid: 3e6 + 6e6 + 2e6, high: 4e6 + 6e6 + 4e6, shows: 3, of: 4 });
  assert.equal(hasReturnedCoverage(p), true);
  // Below 60% of the capital-bearing shows: not stated.
  const thin = buildSeasonProfiles([shows[0], shows[3], shows[3], shows[3]].map((s, i) => ({ ...s, openingDate: `2025-10-0${i + 1}` })));
  assert.equal(hasReturnedCoverage(thin[0]), false);
});
