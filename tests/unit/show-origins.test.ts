/**
 * Path to Broadway findings (src/lib/show-origins.ts, BRO-5842), tested
 * against the real functions (CLAUDE.md §15). Runs in the tsx batch
 * (tests/unit-test-manifest-tsx.txt).
 *
 *  - route and source buckets: [] is direct, one stop is that stop, 2+ is "multiple"
 *  - mix counts new productions only, by era; revivals feed the London-revival row
 *  - recoupment counts only settled, well-tracked seasons and commercial shows,
 *    split musicals vs plays, and names only shows that recouped
 *  - a show with no origin record is left out everywhere
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOriginFindings, returnEngagementIds, routeBucket, sourceBucket, recoupRate, type OriginRecord, type OriginShowInput } from '../../src/lib/show-origins';

const rec = (o: Partial<OriginRecord> = {}): OriginRecord => ({
  path: [], pathNote: null, source: 'original', sourceTitle: null, confidence: 'high', evidence: ['https://www.ibdb.com/x'], ...o,
});
const show = (o: Partial<OriginShowInput> & { id: string; openingDate: string }): OriginShowInput => ({
  type: 'musical', isRevival: false, status: 'closed', criticScore: null, commercial: { designation: 'TBD', recouped: false },
  slug: o.id, title: o.id.toUpperCase(), ...o,
});

test('route and source buckets', () => {
  assert.equal(routeBucket([]), 'direct');
  assert.equal(routeBucket(['london']), 'london');
  assert.equal(routeBucket(['off-broadway', 'international', 'london']), 'multiple');
  assert.equal(sourceBucket('film'), 'screen');
  assert.equal(sourceBucket('tv'), 'screen');
  assert.equal(sourceBucket('play'), 'other');
  assert.equal(sourceBucket('music-catalog'), 'music-catalog');
  assert.equal(sourceBucket('original', 'true-story'), 'true-story');
  assert.equal(sourceBucket('original', 'invented'), 'invented');
  assert.equal(sourceBucket('original'), 'invented');
  assert.equal(recoupRate({ recouped: 1, total: 2, recoupedShows: [] }), null);
  assert.equal(recoupRate({ recouped: 1, total: 4, recoupedShows: [] }), 0.25);
});

test('mix by era, recoupment over settled seasons, revivals apart', () => {
  const shows = [
    show({ id: 'a', openingDate: '2005-10-01', commercial: { designation: 'Windfall', recouped: true } }),
    show({ id: 'b', openingDate: '2005-10-02', type: 'play' }),
    show({ id: 'c', openingDate: '2015-10-01' }),
    show({ id: 'd', openingDate: '2015-10-02', commercial: { designation: 'Nonprofit' } }), // no investors: out of recoupment
    show({ id: 'e', openingDate: '2024-10-01', commercial: { designation: 'Easy Winner', recouped: true } }),
    show({ id: 'f', openingDate: '2026-09-01', status: 'open', commercial: { designation: 'Miracle', recouped: true } }), // season not settled
    show({ id: 'r', openingDate: '2024-10-05', isRevival: true }),
    show({ id: 's', openingDate: '2005-10-05', isRevival: true }),
    show({ id: 'x', openingDate: '2015-10-05' }), // no origin record
    show({ id: 'p', openingDate: '2026-11-08', status: 'previews', type: 'play' }), // announced: current column only
    show({ id: 'u', openingDate: '2027-02-01', status: 'upcoming' }),
    show({ id: 'ur', openingDate: '2027-03-01', status: 'upcoming', isRevival: true }), // revival: not counted
    show({ id: 'un', openingDate: '2027-09-01', status: 'upcoming' }), // next season: not counted
    show({ id: 'sp', openingDate: '2026-11-17', status: 'upcoming', type: 'special' }), // specials: not counted
  ];
  const origins: Record<string, OriginRecord> = {
    a: rec({ path: ['regional-us'], source: 'film' }),
    b: rec({ path: [], source: 'original' }),
    c: rec({ path: ['off-broadway'], source: 'book' }),
    d: rec({ path: ['off-broadway'], source: 'original' }),
    e: rec({ path: ['london', 'regional-us'], source: 'film' }),
    f: rec({ path: ['london'], source: 'music-catalog' }),
    r: rec({ path: ['london'], source: 'original' }),
    p: rec({ path: [], source: 'original' }),
    u: rec({ path: ['london'], source: 'film' }),
    ur: rec({ path: ['london'], source: 'film' }),
    un: rec({ path: ['london'], source: 'film' }),
    sp: rec({ path: [], source: 'original' }),
    s: rec({ path: [], source: 'original' }),
  };
  const f = buildOriginFindings(shows, origins, '2026-10-20');
  assert.equal(f.newProductions, 6);
  assert.deepEqual([f.musicals, f.plays], [5, 1]);
  assert.deepEqual(f.eraTotals, [2, 2, 2]);
  const route = Object.fromEntries(f.routeMix.map((r) => [r.id, r.counts]));
  assert.deepEqual(route.direct, [1, 0, 0]);
  assert.deepEqual(route['off-broadway'], [0, 2, 0]);
  assert.deepEqual(route.multiple, [0, 0, 1]);
  assert.deepEqual(route.london, [0, 0, 1]);
  const ever = Object.fromEntries(f.everPlayed.map((e) => [e.stage, e.count]));
  assert.deepEqual(ever, { 'off-broadway': 2, 'regional-us': 2, london: 2, international: 0 });
  assert.deepEqual(f.musicalEraTotals, [1, 2, 2]);
  assert.deepEqual(f.musicalSourceMix.find((r) => r.id === 'screen')!.counts, [1, 0, 1]);
  assert.deepEqual(f.revivalsFromLondon, { counts: [0, 0, 1], totals: [1, 0, 1] });
  // Current-season column: 2026-27 holds f (opened) plus announced new productions p and u.
  // Announced shows stay out of the era totals and the show list.
  assert.equal(f.currentSeason, '2026-2027');
  assert.deepEqual([f.currentTotal, f.musicalCurrentTotal], [3, 2]);
  assert.equal(f.routeMix.find((r) => r.id === 'london')!.current, 2);
  assert.equal(f.routeMix.find((r) => r.id === 'direct')!.current, 1);
  assert.equal(f.routeMix.reduce((n, r) => n + r.current, 0), 3);
  assert.equal(f.sourceMix.find((r) => r.id === 'music-catalog')!.current, 1);
  assert.equal(f.sourceMix.find((r) => r.id === 'screen')!.current, 1);
  assert.equal(f.showList.some((x) => x.slug === 'p' || x.slug === 'u'), false);

  // Recoupment: a, b, c, e count (d nonprofit, f unsettled 2026-27, x no record).
  const rr = Object.fromEntries(f.routeRecoup.map((r) => [r.id, [r.all.recouped, r.all.total, r.musicals.total, r.plays.total]]));
  assert.deepEqual(rr['regional-us'], [1, 1, 1, 0]);
  assert.deepEqual(rr.direct, [0, 1, 0, 1]);
  assert.deepEqual(rr['off-broadway'], [0, 1, 1, 0]);
  assert.deepEqual(rr.multiple, [1, 1, 1, 0]);
  assert.deepEqual(rr.london, [0, 0, 0, 0]);
  const screen = f.sourceRecoup.find((r) => r.id === 'screen')!;
  assert.deepEqual(screen.all.recoupedShows.map((s) => s.slug), ['a', 'e']);
  assert.equal(f.sourceRecoup.find((r) => r.id === 'invented')!.all.recoupedShows.length, 0); // losses never named

  assert.deepEqual(f.showList.map((s) => s.slug), ['f', 'e', 'd', 'c', 'b', 'a']);
});

test('return engagements and unopened shows leave the new-production mix', () => {
  assert.deepEqual(
    [...returnEngagementIds([
      { id: 'waitress-2016', openingDate: '2016-04-24', isRevival: false },
      { id: 'waitress-2021', openingDate: '2021-09-02', isRevival: false },
      { id: 'hair-2009', openingDate: '2009-03-31', isRevival: true },
      { id: 'hair-2011', openingDate: '2011-07-13', isRevival: false }, // mislabelled revival
      { id: 'gypsy-2008', openingDate: '2008-03-27', isRevival: true },
    ])].sort(),
    ['hair-2011', 'waitress-2021'],
  );
  const shows = [
    show({ id: 'w-2016', openingDate: '2016-10-01' }),
    show({ id: 'w-2021', openingDate: '2021-10-01' }),
    show({ id: 'p', openingDate: '2026-10-01', status: 'previews' }),
    show({ id: 'u', openingDate: '2026-11-08', status: 'open' }),
  ];
  const origins = { 'w-2016': rec(), 'w-2021': rec(), p: rec(), u: rec() };
  const f = buildOriginFindings(shows, origins, '2026-10-20');
  assert.deepEqual(f.showList.map((s) => s.slug), ['w-2016']);
});

test('one-off concerts and different shows that share a title', () => {
  const ret = returnEngagementIds([
    { id: 'frozen-2004', openingDate: '2004-05-04', isRevival: false, creativeTeam: [{ name: 'Bryony Lavery' }] },
    { id: 'frozen-2018', openingDate: '2018-03-22', isRevival: false, creativeTeam: [{ name: 'Jennifer Lee' }] },
    { id: 'fela-2009', openingDate: '2009-11-23', isRevival: false, creativeTeam: [{ name: 'Bill T. Jones' }] },
    { id: 'fela-2012', openingDate: '2012-07-12', isRevival: false, creativeTeam: [{ name: 'Bill T. Jones' }] },
  ]);
  assert.deepEqual([...ret], ['fela-2012']);
  const f = buildOriginFindings(
    [show({ id: 'gala', openingDate: '2004-10-20', closingDate: '2004-10-20' }), show({ id: 'run', openingDate: '2004-10-21', closingDate: '2005-02-01' })],
    { gala: rec(), run: rec() },
    '2026-10-20',
  );
  assert.deepEqual(f.showList.map((s) => s.slug), ['run']);
});
