/**
 * The web Stats view's pure layer (src/lib/stats-ui): scope windows and
 * labels, You-vs-critics alignment buckets, Aisle Mates reviewer detail,
 * format helpers, the stats-shows decoder + merge, and computeStatsBundle on
 * small fixtures including the live-data edge cases (empty diary, unrated
 * rows, undated rows, shows missing from every lookup, no catalog yet).
 *
 * Imports the REAL modules (CLAUDE.md §15). Runs under tsx (registered in
 * tests/unit-test-manifest-tsx.txt) because they are TypeScript with `@/`
 * imports.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { ALL_TIME, buildScopes, filterRows, inScope, localToday, periodTileLabel, scopeSuffix } from '../../src/lib/stats-ui/scope';
import {
  ALIGNMENT_WINDOW,
  CONTRARIAN_MIN_DELTA,
  alignmentLabel,
  audienceVsYou,
  goldCoverage,
  hasDisplayableScore,
  youVsCritics,
} from '../../src/lib/stats-ui/critics';
import { displayNemesis, reviewerDetail } from '../../src/lib/stats-ui/aisle-mates';
import { formatDateSeen, formatHours, formatMonth, groupByVenue, houseShortName, initials, shortMonth, wholeHours } from '../../src/lib/stats-ui/format';
import {
  EMPTY_CANON,
  HOUSE_NAMES,
  MIN_ENTRIES_FOR_STATS,
  computeStatsBundle,
  decodeStatsShows,
  decodeStatsShowsStrict,
  mergeShows,
  toDiaryRows,
} from '../../src/lib/stats-ui/bundle';

const require = createRequire(import.meta.url);
const { projectStatsShows } = require('../../scripts/lib/stats-shows.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CANON = JSON.parse(readFileSync(join(ROOT, 'public/data/stats-canon.json'), 'utf8'));
const TODAY = '2026-10-25';

// ── scope ──────────────────────────────────────────────────────────────

test('buildScopes: All time, then touched Tony seasons, then years, newest first', () => {
  const rows = [
    { show_id: 'a', rating: 4, date_seen: '2025-07-01' }, // 2025-26 season
    { show_id: 'b', rating: 3, date_seen: '2024-03-10' }, // 2023-24 season
    { show_id: 'c', rating: 5, date_seen: null },
  ];
  const scopes = buildScopes(rows, CANON, { today: TODAY });
  assert.deepEqual(scopes[0], ALL_TIME);
  const seasons = scopes.filter((s) => s.kind === 'season').map((s) => s.label);
  // 2026-27 is today's (in-progress) season and always offered.
  assert.deepEqual(seasons, ['Tony season 2026-27', 'Tony season 2025-26', 'Tony season 2023-24']);
  const years = scopes.filter((s) => s.kind === 'year').map((s) => s.year);
  assert.deepEqual(years, [2025, 2024], 'the undated row adds no year');
  const s2526 = scopes.find((s) => s.season === '2025-26');
  assert.equal(s2526.start, '2025-06-09', 'season starts the day after the 2025 ceremony');
  assert.equal(s2526.end, '2026-06-07', 'and ends on the 2026 ceremony');
  assert.equal(scopes.find((s) => s.season === '2026-27').inProgress, true);
});

test('buildScopes survives a missing canon (fetch failed): years only', () => {
  const scopes = buildScopes([{ show_id: 'a', rating: 4, date_seen: '2025-07-01' }], EMPTY_CANON, { today: TODAY });
  assert.deepEqual(
    scopes.map((s) => s.id),
    ['all', 'year:2025'],
  );
});

test('inScope / filterRows: bounds are inclusive and undated rows live in All time only', () => {
  const year = buildScopes([{ show_id: 'a', rating: 4, date_seen: '2025-01-01' }], EMPTY_CANON, { today: TODAY }).find((s) => s.kind === 'year');
  assert.equal(inScope(year, '2025-01-01'), true);
  assert.equal(inScope(year, '2025-12-31'), true);
  assert.equal(inScope(year, '2026-01-01'), false);
  assert.equal(inScope(year, null), false);
  assert.equal(inScope(ALL_TIME, null), true);
  const rows = [{ date_seen: '2025-05-05' }, { date_seen: null }, { date_seen: '2024-05-05' }];
  assert.equal(filterRows(rows, ALL_TIME), rows, 'All time is a no-op');
  assert.deepEqual(filterRows(rows, year), [{ date_seen: '2025-05-05' }]);
});

test('scope labels never mix a season and a calendar frame', () => {
  const scopes = buildScopes([{ show_id: 'a', rating: 4, date_seen: '2026-02-01' }, { show_id: 'b', rating: 4, date_seen: '2023-07-01' }], CANON, { today: TODAY });
  const thisYear = scopes.find((s) => s.year === 2026);
  const pastYear = scopes.find((s) => s.year === 2023);
  const current = scopes.find((s) => s.season === '2026-27');
  const past = scopes.find((s) => s.season === '2023-24');
  assert.equal(periodTileLabel(ALL_TIME), 'Years logged');
  assert.equal(periodTileLabel(thisYear), '2026 so far');
  assert.equal(periodTileLabel(pastYear), 'In 2023');
  assert.equal(periodTileLabel(current), 'This season so far');
  assert.equal(periodTileLabel(past), '2023-24 season');
  assert.equal(scopeSuffix(ALL_TIME), '');
  assert.equal(scopeSuffix(pastYear), ' in 2023');
  assert.equal(scopeSuffix(past), ' in the 2023-24 Tony season');
});

test('localToday uses the local calendar date, zero-padded', () => {
  assert.equal(localToday(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});

// ── critics ────────────────────────────────────────────────────────────

const show = (id, compositeScore, extra = {}) => ({ id, title: id.toUpperCase(), compositeScore, criticReviewCount: 20, category: 'broadway', ...extra });

test('alignmentLabel buckets', () => {
  assert.equal(alignmentLabel(0.7), 'In step with the critics');
  assert.equal(alignmentLabel(0.69), 'Mostly with the critics');
  assert.equal(alignmentLabel(0.5), 'Mostly with the critics');
  assert.equal(alignmentLabel(0.3), 'You go your own way');
  assert.equal(alignmentLabel(0.29), 'Certified contrarian');
});

test('hasDisplayableScore honours the market review minimum', () => {
  assert.equal(hasDisplayableScore(undefined), false);
  assert.equal(hasDisplayableScore(show('a', null)), false);
  assert.equal(hasDisplayableScore(show('a', 80, { criticReviewCount: 1 })), false);
  assert.equal(hasDisplayableScore(show('a', 80, { criticReviewCount: null })), true, 'unknown count does not hide a score');
  assert.equal(hasDisplayableScore(show('a', 80)), true);
});

test('youVsCritics: ±10 window, repeat viewings averaged, unrated and unscored rows skipped, contrarian picks', () => {
  const index = {
    agree: show('agree', 80), // 4★ = 80 → aligned
    edge: show('edge', 70), // 4★ = 80 → |10| still aligned
    loved: show('loved', 50), // 5★ = 100 → +50, you loved it
    raved: show('raved', 95), // avg(2,3)=2.5★ = 50 → -45, critics raved
    thin: show('thin', 90, { criticReviewCount: 1 }), // below the minimum: not comparable
  };
  const rows = [
    { show_id: 'agree', rating: 4, date_seen: '2025-01-01' },
    { show_id: 'edge', rating: 4, date_seen: null },
    { show_id: 'loved', rating: 5, date_seen: '2025-01-02' },
    { show_id: 'raved', rating: 2, date_seen: '2025-01-03' },
    { show_id: 'raved', rating: 3, date_seen: '2025-02-03' },
    { show_id: 'thin', rating: 5, date_seen: '2025-01-04' },
    { show_id: 'agree', rating: 0, date_seen: '2025-03-01' }, // unrated: ignored
    { show_id: 'ghost', rating: 4, date_seen: '2025-01-05' }, // not in any index
  ];
  const r = youVsCritics(rows, index);
  assert.equal(ALIGNMENT_WINDOW, 10);
  assert.equal(r.comparable, 4);
  assert.deepEqual(r.alignedShowIds.sort(), ['agree', 'edge']);
  assert.equal(r.alignment, 0.5);
  assert.equal(r.label, 'Mostly with the critics');
  assert.deepEqual(r.youLovedIt.map((p) => p.showId), ['loved']);
  assert.deepEqual(r.criticsRaved.map((p) => [p.showId, p.rating, p.delta]), [['raved', 2.5, -45]]);
  assert.ok(Math.abs(r.youLovedIt[0].delta) >= CONTRARIAN_MIN_DELTA);
  // mean(critic) − mean(yours) = (80+70+50+95)/4 − (80+80+100+50)/4
  assert.equal(r.bias, (295 - 310) / 4);
});

test('youVsCritics on an empty or all-unrated diary is all zeros, never NaN', () => {
  for (const rows of [[], [{ show_id: 'a', rating: 0, date_seen: null }]]) {
    const r = youVsCritics(rows, { a: show('a', 80) });
    assert.equal(r.comparable, 0);
    assert.equal(r.alignment, 0);
    assert.equal(r.bias, 0);
    assert.equal(r.label, 'Certified contrarian');
  }
});

test('goldCoverage counts open Critical Gold shows, best unseen first', () => {
  const open = [show('g1', 95), show('g2', 99), show('g3', 96), show('meh', 60), show('thin', 99, { criticReviewCount: 1 })];
  const g = goldCoverage([{ show_id: 'g1', rating: 0, date_seen: null }], open);
  assert.equal(g.total, 3, 'unrated diary rows still count as seen; thin and non-gold excluded');
  assert.equal(g.seen, 1);
  assert.deepEqual(g.unseen.map((s) => s.id), ['g2', 'g3']);
  assert.deepEqual(g.seenShowIds, ['g1']);
});

test('audienceVsYou compares ★×20 to the grade midpoint, first rating per show', () => {
  const index = { a: show('a', 80, { audienceGrade: 'A' }), b: show('b', 80, { audienceGrade: 'C' }), c: show('c', 80) };
  const r = audienceVsYou(
    [
      { show_id: 'a', rating: 4.5, date_seen: null }, // 90 vs 93 → aligned
      { show_id: 'b', rating: 5, date_seen: null }, // 100 vs 73 → not
      { show_id: 'c', rating: 4, date_seen: null }, // no grade → not comparable
      { show_id: 'a', rating: 0, date_seen: null },
    ],
    index,
  );
  assert.equal(r.comparable, 2);
  assert.deepEqual(r.alignedShowIds, ['a']);
  assert.equal(r.alignment, 0.5);
});

// ── aisle mates ────────────────────────────────────────────────────────

test('reviewerDetail: shared vs unseen, closest call and biggest fight, outlet by name', () => {
  const reviews = {
    critics: ['Pat Critic', 'Other'],
    outlets: [
      ['The Paper', 1],
      ['The Blog', 3],
    ],
    shows: {
      s1: [[0, 0, 80], [1, 1, 40]], // you 4★=80: Pat agrees exactly
      s2: [[0, 0, 30], [-1, 0, 50]], // you 5★=100: Pat fights by 70
      s3: [[0, 1, 90]], // unseen by you
      s4: [[1, 0, 70]], // Pat absent
    },
  };
  const rows = [
    { show_id: 's1', rating: 4, date_seen: null },
    { show_id: 's2', rating: 5, date_seen: '2025-01-01' },
    { show_id: 's4', rating: 0, date_seen: null }, // unrated: not "shared", not "unseen"
  ];
  const d = reviewerDetail(rows, reviews, { kind: 'critic', index: 0 });
  assert.deepEqual(d.shared, [{ showId: 's1', theirScore: 80 }, { showId: 's2', theirScore: 30 }]);
  assert.equal(d.biggestAgreementShowId, 's1');
  assert.equal(d.biggestFightShowId, 's2');
  assert.deepEqual(d.unseen, [{ showId: 's3', theirScore: 90 }]);

  const outlet = reviewerDetail(rows, reviews, { kind: 'outlet', name: 'The Paper' });
  // s2 has two Paper reviews (one byline-less): averaged.
  assert.deepEqual(outlet.shared.find((s) => s.showId === 's2'), { showId: 's2', theirScore: 40 });
  assert.deepEqual(outlet.unseen, [{ showId: 's4', theirScore: 70 }]);

  // The byline-less (-1) review never matches a critic lookup.
  assert.equal(reviewerDetail(rows, reviews, { kind: 'critic', index: -1 }).shared.length, 0);
});

// ── format ─────────────────────────────────────────────────────────────

test('format helpers', () => {
  assert.equal(formatHours(0), '0m');
  assert.equal(formatHours(45), '45m');
  assert.equal(formatHours(120), '2h');
  assert.equal(formatHours(7365), '122h 45m');
  assert.equal(wholeHours(72240), '1,204');
  assert.equal(formatMonth('2025-10'), 'October 2025');
  assert.equal(shortMonth('2025-01'), 'Jan');
  assert.equal(formatDateSeen('2025-10-04'), 'Oct 4, 2025');
  assert.equal(formatDateSeen(null), 'No date');
  assert.equal(houseShortName('Circle in the Square Theatre'), 'Circle in the Sq.', 'explicit table beats the suffix regex');
  assert.equal(houseShortName('Booth Theatre'), 'Booth', 'falls back to stripping the suffix');
  assert.equal(houseShortName('Lincoln Center Theater - Mitzi E. Newhouse'), 'Mitzi E. Newhouse');
  assert.equal(initials('Jesse Green'), 'JG');
  assert.equal(initials('Cher'), 'C');
  assert.equal(initials('Ben  Van  Brantley'), 'BB');
});

test('groupByVenue: largest group first, ties alphabetical, unknown venues bucketed', () => {
  const venues = { a: 'Booth Theatre', b: 'Booth Theatre', c: 'Ambassador Theatre', d: 'Lyceum Theatre' };
  const groups = groupByVenue(
    [{ show_id: 'a' }, { show_id: 'c' }, { show_id: 'b' }, { show_id: 'd' }, { show_id: 'zzz' }],
    (id) => venues[id],
  );
  assert.deepEqual(
    groups.map((g) => [g.venue, g.reviews.length]),
    [
      ['Booth Theatre', 2],
      ['Ambassador Theatre', 1],
      ['Lyceum Theatre', 1],
      ['Unknown venue', 1],
    ],
  );
});

// ── stats-shows decode + merge ─────────────────────────────────────────

const LOOKUP = {
  'open-show': { id: 'open-show', title: 'Open Show', slug: 'open-show', venue: 'Booth Theatre', type: 'musical', status: 'open', category: 'broadway', previewDate: null, openingDate: null, closingDate: null, compositeScore: null, posterUrl: '/p.jpg', runtimeMin: 150 },
  'diary-only': { id: 'diary-only', title: 'Regional Thing', slug: 'diary-only', venue: 'Goodman Theatre', type: 'play', status: 'closed', category: 'regional', previewDate: null, openingDate: null, closingDate: null, compositeScore: null, posterUrl: null, diaryOnly: true },
};

test('decodeStatsShows round-trips the generator projection and tolerates junk', () => {
  const projected = projectStatsShows([
    { id: 'open-show', t: 'Open Show', s: 'open-show', v: 'Booth Theatre', st: 'previews', ty: 'musical', cs: 91.2, cr: { rc: 30 }, ag: { g: 'A+' } },
    { id: 'old', t: 'Old', s: 'old', v: 'Y', st: 'closed', ty: 'musical', cat: 'off-broadway', img: { po: '/o.jpg' }, cs: 70 },
  ]);
  const decoded = Object.fromEntries(decodeStatsShows(projected).map((s) => [s.id, s]));
  assert.equal(decoded['open-show'].compositeScore, 91.2);
  assert.equal(decoded['open-show'].criticReviewCount, 30);
  assert.equal(decoded['open-show'].audienceGrade, 'A+');
  assert.equal(decoded['open-show'].status, 'previews');
  assert.equal(decoded['open-show'].hasMeta, false);
  assert.deepEqual(
    [decoded.old.title, decoded.old.slug, decoded.old.venue, decoded.old.category, decoded.old.type, decoded.old.posterUrl, decoded.old.status, decoded.old.hasMeta],
    ['Old', 'old', 'Y', 'off-broadway', 'musical', '/o.jpg', 'closed', true],
  );
  for (const junk of [null, undefined, 42, 'x', { shows: null }, { shows: { a: 'nope' } }, { shows: [] }]) {
    assert.deepEqual(decodeStatsShows(junk), [], `junk ${JSON.stringify(junk)}`);
  }
});

test('mergeShows: lookup wins display and status, catalog supplies numbers, number-only rows dropped', () => {
  const catalog = decodeStatsShows({
    shows: { 'open-show': [91.2, 30, 'A+', 'previews'], 'meta-only': [70], 'numbers-only': [80, 20] },
    meta: { 'meta-only': ['Meta Only', 'meta-only', 'Y', 'off-broadway', 0, null] },
  });
  const merged = mergeShows(LOOKUP, catalog);
  assert.equal(merged['open-show'].title, 'Open Show');
  assert.equal(merged['open-show'].status, 'open', 'show-lookup status is rebuilt daily; it wins');
  assert.equal(merged['open-show'].compositeScore, 91.2);
  assert.equal(merged['open-show'].runtime, 150);
  assert.equal(merged['diary-only'].diaryOnly, true);
  assert.equal(merged['diary-only'].compositeScore, null);
  assert.equal(merged['meta-only'].title, 'Meta Only');
  assert.equal(merged['numbers-only'], undefined, 'no title anywhere: never render a raw id');
  // Catalog not loaded yet (or failed): the lookup alone still merges.
  assert.equal(mergeShows(LOOKUP, [])['open-show'].compositeScore, null);
});

// ── computeStatsBundle ─────────────────────────────────────────────────

const review = (show_id, rating, date_seen) => ({
  id: `${show_id}-${date_seen}-${rating}`,
  user_id: 'u',
  show_id,
  rating,
  review_text: null,
  date_seen,
  visibility: 'private',
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-01T00:00:00Z',
});

const SHOWS = mergeShows(
  {
    ...LOOKUP,
    'lyceum-show': { ...LOOKUP['open-show'], id: 'lyceum-show', title: 'Lyceum Show', slug: 'lyceum-show', venue: 'Lyceum Theatre', status: 'closed', runtimeMin: 100 },
    'gold-unseen': { ...LOOKUP['open-show'], id: 'gold-unseen', title: 'Gold Unseen', slug: 'gold-unseen', venue: 'Gershwin Theatre', status: 'open' },
  },
  decodeStatsShows({ shows: { 'open-show': [80, 30, 'A'], 'lyceum-show': [60, 25], 'gold-unseen': [97, 40, 'A+'] }, meta: {} }),
);

test('computeStatsBundle: empty diary is a well-formed zero bundle', () => {
  const b = computeStatsBundle({ reviews: [], shows: SHOWS, canon: CANON, statsReviews: null, scope: null, today: TODAY });
  assert.equal(b.allRows.length, 0);
  assert.equal(b.diary.total, 0);
  assert.equal(b.diary.minutesInSeat, 0);
  assert.equal(b.distinctShows, 0);
  assert.equal(b.critics.comparable, 0);
  assert.equal(b.theaters.visited, 0);
  assert.equal(b.aisleMates, null, 'no stats-reviews yet');
  assert.equal(b.gold.total, 1);
  assert.equal(b.gold.seen, 0);
  assert.equal(b.hoursEstimated, false);
  assert.deepEqual(b.scope, ALL_TIME);
});

test('computeStatsBundle: below the minimum the bundle still computes (the view shows the ghost)', () => {
  const reviews = [review('open-show', 4, '2025-07-01'), review('diary-only', 0, null)];
  assert.ok(reviews.length < MIN_ENTRIES_FOR_STATS);
  const b = computeStatsBundle({ reviews, shows: SHOWS, canon: CANON, statsReviews: null, scope: null, today: TODAY });
  assert.equal(b.allRows.length, 2);
  assert.equal(b.diary.unrated, 1);
  assert.equal(b.diary.undated, 1);
});

test('computeStatsBundle: unrated, undated and unknown shows never crash and land in the right buckets', () => {
  const reviews = [
    review('open-show', 4, '2025-07-01'),
    review('open-show', 5, '2026-02-01'), // repeat viewing
    review('lyceum-show', 3, '2024-03-10'),
    review('diary-only', 0, null), // unrated + undated, diary-only regional show
    review('not-in-any-lookup', 4.5, '2025-09-09'), // show unknown to every file
    review('gold-unseen', 0, '2026-03-03'), // seen but unrated
  ];
  const statsReviews = { critics: ['Pat'], outlets: [['The Paper', 1]], shows: { 'open-show': [[0, 0, 85]] } };
  const b = computeStatsBundle({ reviews, shows: SHOWS, canon: CANON, statsReviews, scope: null, today: TODAY });

  assert.equal(b.diary.total, 6);
  assert.equal(b.diary.unrated, 2);
  assert.equal(b.diary.undated, 1);
  assert.equal(b.distinctShows, 5);
  assert.equal(b.histogram.unrated, 2);
  assert.ok(Number.isFinite(b.diary.minutesInSeat) && b.diary.minutesInSeat > 0);
  // Broadway houses: Booth (open-show) + Lyceum + Gershwin; the regional and the unknown show are not misses.
  assert.equal(b.theaters.visited, 3);
  assert.equal(b.theaters.operating, HOUSE_NAMES.length);
  // Critics: open-show (avg 4.5★=90 vs 80) and lyceum-show (60 vs 60) are comparable; the unknown show is not.
  assert.equal(b.critics.comparable, 2);
  assert.deepEqual(b.critics.alignedShowIds.sort(), ['lyceum-show', 'open-show']);
  // Gold: the unrated diary row still counts as seen.
  assert.equal(b.gold.seen, 1);
  assert.ok(b.aisleMates, 'aisle mates computed once stats-reviews is present');

  // A year scope drops the undated row and keeps the lifetime modules lifetime.
  const y2025 = b.scopes.find((s) => s.kind === 'year' && s.year === 2025);
  const scoped = computeStatsBundle({ reviews, shows: SHOWS, canon: CANON, statsReviews, scope: y2025, today: TODAY });
  assert.equal(scoped.diary.total, 2);
  assert.deepEqual(scoped.reviewsInScope.map((r) => r.show_id).sort(), ['not-in-any-lookup', 'open-show']);
  assert.equal(scoped.theaters.visited, 3, 'theaters are lifetime');
  assert.equal(scoped.critics.comparable, 1, 'critics are scoped');
});

test('computeStatsBundle: no catalog and no canon (both fetches failed) still computes', () => {
  const reviews = [review('open-show', 4, '2025-07-01'), review('lyceum-show', 3, '2024-03-10'), review('x', 2, null)];
  const b = computeStatsBundle({ reviews, shows: mergeShows(LOOKUP, []), canon: EMPTY_CANON, statsReviews: null, scope: null, today: TODAY });
  assert.equal(b.diary.total, 3);
  assert.equal(b.critics.comparable, 0);
  assert.equal(b.canonStats.bestMusical.total, 0);
  assert.deepEqual(
    b.scopes.map((s) => s.id),
    ['all', 'year:2025', 'year:2024'],
  );
});

test('toDiaryRows keeps only the engine fields', () => {
  assert.deepEqual(toDiaryRows([review('a', 3.5, null)]), [{ show_id: 'a', rating: 3.5, date_seen: null }]);
});

test('decodeStatsShowsStrict turns an empty catalog into a load error', () => {
  // prebuild writes {"shows":{}} when mobile-shows.json is unreadable; the page
  // must show the Retry card rather than empty critic modules.
  assert.throws(() => decodeStatsShowsStrict({ shows: {} }), /empty/);
  assert.throws(() => decodeStatsShowsStrict(null), /empty/);
  assert.equal(decodeStatsShowsStrict({ shows: { 'x-2020': [80, 12, 'A', 'open'] } }).length, 1);
});

test('displayNemesis only labels a genuinely low aligner who is not already listed', () => {
  const a = (name, alignment) => ({ name, alignment, shared: 10 });
  // Worst of the pool is 70%: not a nemesis.
  assert.equal(displayNemesis({ nemesis: a('X', 0.7), topMates: [], rising: [] }), null);
  // Low, but already shown as a rising match: not a nemesis.
  assert.equal(displayNemesis({ nemesis: a('Y', 0.2), topMates: [], rising: [a('Y', 0.2)] }), null);
  // Low and unlisted: shown.
  assert.equal(displayNemesis({ nemesis: a('Z', 0.15), topMates: [a('M', 0.8)], rising: [] }).name, 'Z');
  assert.equal(displayNemesis({ nemesis: null, topMates: [], rising: [] }), null);
});
