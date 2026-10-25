// Pool + query selection for scripts/discover-regional-serp-reviews.js (BRO-4509).
// National tours used to be outside the weekly pool, so nothing searched for
// their reviews; these pin that tours are in and the regional query is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { selectDiscoveryShows, buildDiscoveryQuery, buildDiscoveryDateRange, tourCandidateIsTour, tourCandidateVerdict } = require('./regional-serp-discovery.js');
const { calculateDateWindow } = require('./url-discovery.js');

const regional = { id: 'purpose-regional-2026', title: 'Purpose', market: 'regional', status: 'open', venue: 'Huntington Theatre Company (Calderwood Pavilion), Boston, MA' };
const tour = { id: 'oh-mary-tour-2026', title: 'Oh, Mary!', market: 'tour', status: 'open', venue: 'North American Tour' };
const oldTour = { id: 'suffs-tour-2025', title: 'Suffs', market: 'tour', status: 'closed', venue: 'North American Tour', closingDate: '2020-01-01' };
const broadway = { id: 'oh-mary-2024', title: 'Oh, Mary!', market: 'broadway', status: 'open', venue: 'Lyceum Theatre' };
const noCity = { id: 'x-regional-2026', title: 'X', market: 'regional', status: 'open', venue: 'Somewhere' };

test('pool includes open regional and tour shows, excludes Broadway and stale closed tours', () => {
  const ids = selectDiscoveryShows([regional, tour, oldTour, broadway], null).map((s) => s.id);
  assert.deepEqual(ids, ['purpose-regional-2026', 'oh-mary-tour-2026']);
});

test('--show filter still restricts to the discovery markets', () => {
  assert.deepEqual(selectDiscoveryShows([tour, broadway], 'oh-mary-tour-2026').map((s) => s.id), ['oh-mary-tour-2026']);
  assert.deepEqual(selectDiscoveryShows([tour, broadway], 'oh-mary-2024'), []);
});

test('regional query keeps the city form; tour query names the tour', () => {
  assert.equal(buildDiscoveryQuery(regional), '"Purpose" review Boston');
  assert.equal(buildDiscoveryQuery(tour), '"Oh, Mary!" national tour review');
  assert.equal(buildDiscoveryQuery(noCity), null);
});

test('long-running tour gets a rolling window; regional keeps the shared window', () => {
  const now = new Date('2026-10-02T00:00:00Z');
  const longTour = { ...tour, id: 'book-of-mormon-tour-2022', openingDate: '2022-08-31' };
  const r = buildDiscoveryDateRange(longTour, now);
  assert.equal(r.dateMax.toISOString().slice(0, 10), '2026-11-01');
  assert.equal(r.dateMin.toISOString().slice(0, 10), '2026-06-04');
  const closed = buildDiscoveryDateRange({ ...longTour, closingDate: '2026-09-01' }, now);
  assert.equal(closed.dateMax.toISOString().slice(0, 10), '2026-10-01');
  // A closed tour is searched over its final 120 days, not today's window
  // (which would hold nothing) and not its opening window (years stale).
  const longClosed = { ...longTour, status: 'closed', closingDate: '2025-09-14' };
  const lc = buildDiscoveryDateRange(longClosed, now);
  const day = (r) => [r.dateMin, r.dateMax].map((d) => d.toISOString().slice(0, 10));
  assert.deepEqual(day(lc), ['2025-05-17', '2025-10-14']);
  const recent = buildDiscoveryDateRange({ ...longTour, status: 'closed', closingDate: '2026-06-07' }, now);
  assert.deepEqual(day(recent), ['2026-02-07', '2026-07-07']);
  const reg = { ...regional, openingDate: '2026-09-10' };
  // calculateDateWindow reads the wall clock itself, so compare to the day.
  assert.deepEqual(day(buildDiscoveryDateRange(reg, now)), day(calculateDateWindow(reg)));
});

test('tour with no openingDate still gets a bounded window', () => {
  const now = new Date('2026-10-02T00:00:00Z');
  const r = buildDiscoveryDateRange(tour, now);
  assert.ok(r && r.dateMin && r.dateMax, 'expected a bounded range');
  assert.equal(r.dateMax.toISOString().slice(0, 10), '2026-11-01');
  assert.equal(r.dateMin.toISOString().slice(0, 10), '2026-06-04');
});

test('tour candidates pointing at Broadway without a tour mention are rejected; others pass', () => {
  assert.equal(tourCandidateIsTour(tour, { url: 'https://joshatthemovies.com/2026/09/25/theater-review-oh-mary/', title: 'Theater Review: Oh, Mary!' }), true);
  assert.equal(tourCandidateIsTour(tour, { url: 'https://example.com/oh-mary', title: 'Oh, Mary! review', snippet: 'Cole Escola returns to Broadway' }), false);
  assert.equal(tourCandidateIsTour(tour, { url: 'https://example.com/oh-mary', title: 'Oh, Mary! review', snippet: 'The Broadway hit tours to Hartford' }), true);
  assert.equal(tourCandidateIsTour(tour, { url: 'https://www.timesofsandiego.com/arts/2026/10/01/oh-mary-san-diego-national-tour/', title: 'Oh, Mary!' }), true);
  assert.equal(tourCandidateIsTour(tour, { url: 'https://www.courant.com/2026/09/21/theater-review-tour-premiere-of-freaky-farce/', title: 'Theater review' }), true);
  assert.equal(tourCandidateIsTour(tour, { url: 'https://example.com/review-oh-mary', title: 'Review', snippet: 'The touring production lands at the Bushnell' }), true);
  assert.equal(tourCandidateIsTour(tour, { url: 'https://www.nytimes.com/2024/07/11/theater/oh-mary-review.html', title: "'Oh, Mary!' Review: Cole Escola at the Lyceum" }), false);
  assert.equal(tourCandidateIsTour(regional, { url: 'https://example.com/purpose-review', title: 'Purpose review' }), true);
});

// BRO-4931: a local review of the touring company need not say "tour". Fixtures
// are real kinky-boots-tour-2025 URLs (stop-window search) and the pages the
// weekly and stop jobs ingested by mistake.
const kinky = { id: 'kinky-boots-tour-2025', title: 'Kinky Boots', market: 'tour' };

test('local reviews of the touring company pass without a tour word (BRO-4931)', () => {
  const pass = [
    ['https://www.independent.com/2025/12/11/theater-review-kinky-boots-kicks-off-the-broadway-in-santa-barbara-series-with-a-bang/', "Theater Review | 'Kinky Boots' Kicks Off the Broadway in Santa Barbara Series with a Bang"],
    ['https://dailyiowan.com/2026/01/25/review-kinky-boots-was-a-fierce-opening-to-hanchers-broadway-series/', "Review | 'Kinky Boots' was a fierce opening to Hancher's Broadway series"],
    ['https://www.broadwayworld.com/san-francisco/article/Review-KINKY-BOOTS-at-Broadway-San-Jose-20251129', 'Review: KINKY BOOTS at Broadway San Jose'],
    ['https://www.broadwayworld.com/central-new-york/article/Review-KINKY-BOOTS-at-Clemens-Center-20251120', 'Review: KINKY BOOTS at Clemens Center'],
    ['https://www.spokesman.com/stories/2025/dec/11/past-glamour-and-high-energy-songs-kinky-boots-is-/', "Past glamour and high-energy songs, 'Kinky Boots' is about heart, connection"],
    ['https://www.yahoo.com/entertainment/articles/theater-review-kinky-boots-revival-090000000.html', "Theater review: 'Kinky Boots' revival tour has raw energy, wild spirit and lots of love"],
  ];
  for (const [url, title] of pass) assert.equal(tourCandidateVerdict(kinky, { url, title }).ok, true, url);
});

test('non-review pages, overseas editions and the Broadway company stay rejected (BRO-4931)', () => {
  const reject = [
    ['https://www.broadwayworld.com/chicago/article/InterviewFeature-KINKY-BOOTS-Dancing-in-Heels-Workshop-20260610', 'non-review'],
    ['https://www.broadwayworld.com/chicago/article/KINKY-BOOTS-is-Now-Playing-at-Chicagos-James-M-Nederlander-Theatre-20260609', 'non-review'],
    ['https://www.broadwayworld.com/belgium/article/Review-KINKY-BOOTS-at-Chteau-Du-Karreveld-20260822', 'overseas'],
    ['http://theater.nytimes.com/2013/04/05/theater/reviews/kinky-boots-the-harvey-fierstein-cyndi-lauper-musical.html', 'broadway-company'],
    ['http://www.vulture.com/2013/04/theater-review-kinky-boots.html', 'broadway-company'],
    ['https://www.broadwayworld.com/article/Review-KINKY-BOOTS-at-The-Al-Hirschfeld-Theatre-20130404', 'broadway-company'],
    ['https://www.broadwayworld.com/off-broadway/article/Review-KINKY-BOOTS-at-Somewhere-20260301', 'broadway-company'],
    ['https://www.broadwayworld.com/reviews/Kinky-Boots', 'non-review'],
  ];
  for (const [url, reason] of reject) {
    const v = tourCandidateVerdict(kinky, { url, title: 'Kinky Boots' });
    assert.deepEqual([v.ok, v.reason], [false, reason], url);
  }
  // No tour word, unknown host, snippet places the show back on Broadway.
  assert.equal(tourCandidateVerdict(kinky, { url: 'https://example.com/kinky-boots-review', title: 'Kinky Boots review', snippet: 'The musical returns to Broadway' }).ok, false);
  // Interview and preview pages on a local outlet.
  assert.equal(tourCandidateVerdict(kinky, { url: 'https://www.independent.com/2025/12/01/kinky-boots-at-the-granada/', title: 'Interview: Omari Collins' }).ok, false);
  assert.equal(tourCandidateVerdict(kinky, { url: 'https://example.com/2026/01/preview-kinky-boots-at-hancher/', title: 'Preview: Kinky Boots' }).ok, false);
  // A Broadway-market outlet that does name the tour still passes (legacy contract).
  assert.equal(tourCandidateVerdict(kinky, { url: 'https://www.nytimes.com/2026/01/x/kinky-boots-national-tour.html', title: 'Kinky Boots national tour' }).ok, true);
  // Non-tour shows are never judged here.
  assert.equal(tourCandidateVerdict({ market: 'regional' }, { url: 'https://www.broadwayworld.com/belgium/article/x', title: 'x' }).ok, true);
});
