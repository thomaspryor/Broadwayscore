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
  assert.equal(row('Musicals').avg, 6 / 30); // pooled 2+2+2 of 30; 2019-20's 9 musicals excluded

  // 2025-26 ended Jul 2026: still settling, so labelled "so far". All three
  // baseline seasons ended over a year before Sep 2026: settled.
  assert.equal(cmp.recoupUnsettled, true);
  assert.equal(cmp.baselineSeasons, 3);
  assert.equal(row('Commercial shows recouped so far').avgSeasons, 3);
  assert.equal(row('Commercial shows recouped so far').avg, 3 / 30);

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

test('sums are compared only when both seasons disclose nearly every budget', () => {
  const shows = [
    // 2025-26: 6 of 10 disclosed (60%): shown, not compared.
    ...season(2025, 10, { tracked: true, cap: 5e6 }).map((s, i) => (i < 4 ? { ...s, commercial: com({ capitalization: null }) } : s)),
    ...season(2024, 10, { tracked: true, cap: 4e6 }),
  ];
  const cmp = compareSeason(buildSeasonProfiles(shows), '2025-2026', '2026-09-01')!;
  const sum = cmp.rows.find((r) => r.label === 'Disclosed capitalization (sum)')!;
  assert.deepEqual([sum.current, sum.currentDetail, sum.last, sum.avg], [30e6, '6 of 10 disclosed', null, null]);
});

test('recoupment average leaves out seasons still playing out', () => {
  const shows = [
    ...season(2026, 5, { tracked: true }),
    ...season(2025, 10, { tracked: true }), // ended Jul 2026: not settled by Oct 2026
    ...season(2024, 10, { tracked: true }),
  ];
  const cmp = compareSeason(buildSeasonProfiles(shows), '2026-2027', '2026-10-20')!;
  const r = cmp.rows.find((x) => x.label === 'Commercial shows recouped so far')!;
  assert.equal(r.last, 0.1); // last season is still shown
  assert.equal(r.avgSeasons, 1); // but only 2024-25 is averaged
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

test('a season under way: sum stated not compared; budgets judged on the whole announced slate', () => {
  const shows = [
    // 2026-27: 6 musicals announced, only 3 in commercial.json, all disclosed.
    ...[0, 1, 2].map((i) => show({ openingDate: `2026-1${i}-01`, type: 'musical', commercial: com({ capitalization: 20e6 }) })),
    ...[0, 1, 2].map((i) => show({ openingDate: `2027-0${i + 1}-15`, type: 'musical' })),
    ...season(2025, 10, { musicals: 10, tracked: true, cap: 15e6 }),
  ];
  const cmp = compareSeason(buildSeasonProfiles(shows), '2026-2027', '2026-10-20')!;
  const row = (label: string) => cmp.rows.find((r) => r.label === label)!;
  const avg = row('Average capitalization, musical');
  assert.deepEqual([avg.current, avg.currentDetail, avg.last], [null, '3 of 6 disclosed', 15e6]);
  const sum = row('Disclosed capitalization (sum)');
  assert.deepEqual([sum.current, sum.last, sum.avg], [60e6, null, null]);
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
  assert.equal(cmp.baselineSeasons, 0);
  assert.equal(recoup.last, 0.2);
});

test('who recoups: buckets over finished, well-tracked seasons; critic bands over decided shows', () => {
  const r = (o: Partial<Parameters<typeof buildRecoupFindings>[0][number]> & { openingDate: string }) => ({
    type: 'play', isRevival: false, status: 'closed', criticScore: 70, commercial: com({}), ...o,
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
