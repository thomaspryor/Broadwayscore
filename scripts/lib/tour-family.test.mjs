import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pickTourForDate, tourWindows, toursOfTitle, runningTourFor, TOUR_PARENT_CATEGORIES, tourInheritance, tourImageProblems, tourLinkProblems, productionsOfTitle } = require('./tour-family.js');
const { classifyMarketRouting, buildSiblingIndex } = require('./market-routing.js');
const { isLikelyTourReview } = require('./review-guards.js');
const { isNotBroadway } = require('./content-filters.js');

const NOW = new Date('2026-09-28T00:00:00Z');
const bway = { id: 'wicked-2003', title: 'Wicked', category: 'broadway', openingDate: '2003-10-30' };
const tour1 = { id: 'wicked-tour-2005', title: 'Wicked', category: 'tour', tourOf: 'wicked-2003', openingDate: '2005-03-09', closingDate: '2012-01-15' };
const tour2 = { id: 'wicked-tour-2013', title: 'Wicked', category: 'tour', tourOf: 'wicked-2003', openingDate: '2013-03-01' };

test('dated review lands on the tour whose window holds it', () => {
  assert.deepEqual(pickTourForDate([tour1, tour2], { publishDate: '2008-05-01' }, NOW), { tourId: 'wicked-tour-2005', reason: 'in-tour-window' });
  assert.equal(pickTourForDate([tour1, tour2], { publishDate: '2019-05-01' }, NOW).tourId, 'wicked-tour-2013');
});

test('a week before launch counts; 60 days after close counts; beyond does not', () => {
  assert.equal(pickTourForDate([tour1], { publishDate: '2005-03-03' }, NOW).tourId, 'wicked-tour-2005');
  assert.equal(pickTourForDate([tour1], { publishDate: '2005-02-20' }, NOW).tourId, null);
  assert.equal(pickTourForDate([tour1], { publishDate: '2012-03-10' }, NOW).tourId, 'wicked-tour-2005');
  assert.equal(pickTourForDate([tour1], { publishDate: '2012-04-20' }, NOW).tourId, null);
});

test('the earlier tour window ends where the next tour begins', () => {
  const [w1] = tourWindows([{ ...tour1, closingDate: null }, tour2], NOW);
  assert.equal(w1.end.toISOString().slice(0, 10), '2013-02-22');
});

test('URL-derived dates are not trusted; undated goes only to a single running tour', () => {
  assert.equal(pickTourForDate([tour1, tour2], { publishDate: '2008-05-01', dateSource: 'url' }, NOW).tourId, null);
  assert.equal(pickTourForDate([tour2], { publishDate: '2008-05-01', dateSource: 'url' }, NOW).tourId, 'wicked-tour-2013');
  assert.equal(pickTourForDate([tour1], {}, NOW).tourId, null, 'closed tour never takes undated reviews');
});

test('toursOfTitle and runningTourFor', () => {
  const shows = [bway, tour1, tour2];
  assert.deepEqual(toursOfTitle('WICKED!', shows).map(s => s.id), ['wicked-tour-2005', 'wicked-tour-2013']);
  assert.equal(runningTourFor(bway, shows, NOW), null, 'two tours, one running: undated rule needs exactly one tour');
  assert.equal(runningTourFor(bway, [bway, tour2], NOW), 'wicked-tour-2013');
});

const shows = [bway, tour2, { id: 'wicked-west-end-2006', title: 'Wicked', category: 'west-end', openingDate: '2006-09-27' }];
const idx = buildSiblingIndex(shows);
const route = (showId, url, publishDate, extra = {}) =>
  classifyMarketRouting({ showId, url, publishDate, category: shows.find(s => s.id === showId).category, siblingIndex: idx, ...extra });

test('Broadway target + tour-stop URL + tour window = reroute to the tour', () => {
  const d = route('wicked-2003', 'https://www.broadwayworld.com/denver/article/Review-WICKED-at-the-Buell-20190501', '2019-05-01');
  assert.equal(d.action, 'reroute');
  assert.equal(d.targetShowId, 'wicked-tour-2013');
});

test('tour-stop URL outside every tour window is not rerouted', () => {
  const d = route('wicked-2003', 'https://www.broadwayworld.com/denver/article/Review-WICKED-20100501', '2010-05-01');
  assert.notEqual(d.targetShowId, 'wicked-tour-2013');
});

test('a New York review is never handed to the tour by date proximity', () => {
  const d = route('wicked-2003', 'https://www.nytimes.com/2013/03/05/theater/wicked-anniversary.html', '2013-03-05');
  assert.equal(d.action, 'accept');
});

test('a review filed on the tour is never rerouted to Broadway by date proximity', () => {
  const d = route('wicked-tour-2013', 'https://www.denverpost.com/2013/03/10/wicked-review/', '2013-03-10');
  assert.equal(d.action, 'accept');
});

test('tour guard: tour target accepts US city pages, rejects West End pages', () => {
  assert.equal(isLikelyTourReview('https://www.broadwayworld.com/denver/article/Review-WICKED', 'wicked-tour-2013'), false);
  assert.equal(isLikelyTourReview('https://www.houstonchronicle.com/review-wicked', 'wicked-tour-2013'), false);
  assert.equal(isLikelyTourReview('https://www.broadwayworld.com/westend/article/Review-WICKED', 'wicked-tour-2013'), true);
  assert.equal(isLikelyTourReview('https://www.broadwayworld.com/denver/article/Review-WICKED', 'wicked-2003'), true, 'Broadway target unchanged');
});

test('isNotBroadway: tour language is fine for a tour target only', () => {
  assert.equal(isNotBroadway('Review: WICKED national tour in Chicago'), true);
  assert.equal(isNotBroadway('Review: WICKED national tour in Chicago', { allowTour: true }), false);
});

test('tours inherit the parent archived thumbnail/poster and synopsis, never the hero or a remote URL', () => {
  const { tourInheritance, applyTourInheritance } = require('./tour-family.js');
  const parent = { id: 'p', images: { hero: '/images/shows/p/hero.webp', thumbnail: '/images/shows/p/thumbnail.webp', poster: 'https://cdn.example.com/p.jpg' }, synopsis: 'Story.', runtime: '2h 30m' };
  const tour = { id: 't', category: 'tour', tourOf: 'p', images: { hero: null, thumbnail: null, poster: null } };
  assert.deepEqual(tourInheritance(tour, parent), { images: { hero: null, thumbnail: '/images/shows/p/thumbnail.webp', poster: null }, synopsis: 'Story.', runtime: '2h 30m' });
  const own = { ...tour, images: { thumbnail: '/images/shows/t/thumbnail.webp' }, synopsis: 'Tour story.', runtime: '2h 25m' };
  assert.equal(tourInheritance(own, { ...parent, images: { thumbnail: '/images/shows/p/thumbnail.webp' } }), null, 'own art, synopsis and runtime win');
  assert.equal(tourInheritance({ id: 'b', category: 'broadway' }, parent), null);
  const shows = [parent, tour];
  assert.deepEqual(applyTourInheritance(shows), ['t']);
  assert.equal(shows[1].images.thumbnail, '/images/shows/p/thumbnail.webp');
  assert.deepEqual(applyTourInheritance(shows), [], 'idempotent');
});

test('tourImageProblems: own or same-title Broadway art only', () => {
  const { tourImageProblems } = require('./tour-family.js');
  const shows = [
    { id: 'shucked-2023', title: 'Shucked', category: 'broadway' },
    { id: 'six-2021', title: 'SIX', category: 'broadway' },
  ];
  const ok = { id: 'shucked-tour-2024', title: 'Shucked', category: 'tour', images: { thumbnail: '/images/shows/shucked-2023/thumbnail.webp', poster: '/images/shows/shucked-tour-2024/poster.webp', hero: null } };
  assert.deepEqual(tourImageProblems(ok, shows), []);
  const bad = { ...ok, images: { hero: '/images/shows/six-2021/hero.webp', poster: 'https://x.test/p.jpg' } };
  assert.equal(tourImageProblems(bad, shows).length, 2);
});

test('poster and runtime come only from a parent that is plausibly the production on the road', () => {
  const { tourInheritance } = require('./tour-family.js');
  const parent = { id: 'mark-twain-tonight-2005', title: 'Mark Twain Tonight!', category: 'broadway', status: 'closed', closingDate: '2005-06-26', synopsis: 'Twain.', runtime: '2h', images: { thumbnail: '/images/shows/mt/thumbnail.webp' } };
  const tour = { id: 'mark-twain-tonight-tour-2027', title: 'Mark Twain Tonight!', category: 'tour', openingDate: '2027-01-28' };
  assert.deepEqual(tourInheritance(tour, parent), { synopsis: 'Twain.' }, '22 years on: story only');
  assert.ok(tourInheritance({ ...tour, openingDate: '2007-01-28' }, parent).runtime, 'within 3 years: same production');
  assert.ok(tourInheritance(tour, { ...parent, status: 'open', closingDate: null }).images, 'parent still running');
  const earlier = { id: 'mark-twain-tonight-tour-2024', title: 'Mark Twain Tonight!', category: 'tour', openingDate: '2024-10-01' };
  assert.ok(tourInheritance(tour, parent, [parent, earlier, tour]).images, 'an earlier tour of the title: a touring production exists');
});

// ---- BRO-4931: tours of any market, and standalone tours --------------------

const img = id => `/images/shows/${id}/poster.webp`;
const offB = { id: 'mexodus-off-broadway-2026', title: 'Mexodus', category: 'off-broadway', status: 'open', openingDate: '2026-03-01',
  synopsis: 'A road story.', runtime: '2h', images: { hero: img('mexodus-off-broadway-2026').replace('poster', 'hero'), thumbnail: img('mexodus-off-broadway-2026').replace('poster', 'thumbnail'), poster: img('mexodus-off-broadway-2026') }, cast: [{ name: 'A' }] };
const mexTour = { id: 'mexodus-tour-2026', title: 'Mexodus', category: 'tour', tourOf: offB.id, openingDate: '2026-09-20', images: { hero: null, thumbnail: null, poster: null } };

test('TOUR_PARENT_CATEGORIES is every non-tour market, Broadway first', () => {
  assert.deepEqual(TOUR_PARENT_CATEGORIES, ['broadway', 'off-broadway', 'regional', 'west-end', 'off-west-end']);
});

test('a tour inherits synopsis, runtime and key art from an Off-Broadway parent, never the hero or cast', () => {
  const patch = tourInheritance(mexTour, offB, [offB, mexTour]);
  assert.equal(patch.synopsis, 'A road story.');
  assert.equal(patch.runtime, '2h');
  assert.equal(patch.images.poster, img(offB.id));
  assert.equal(patch.images.hero, null);
  assert.equal(patch.cast, undefined);
});

test('the same-production rule still gates art and runtime for a regional or West End parent', () => {
  const old = { ...offB, category: 'west-end', status: 'closed', closingDate: '2015-01-01' };
  const patch = tourInheritance(mexTour, old, [old, mexTour]);
  assert.deepEqual(Object.keys(patch), ['synopsis']);
});

test('a standalone tour (no parent) inherits nothing, and a tour is never a parent', () => {
  assert.equal(tourInheritance({ ...mexTour, tourOf: undefined }, null, [mexTour]), null);
  assert.equal(tourInheritance(mexTour, { ...mexTour, id: 'other-tour-2020', synopsis: 'x' }, []), null);
});

test('tour art may come from the tour, its parent, or same-title productions in the parent category or on Broadway', () => {
  const bway = { id: 'mexodus-2027', title: 'Mexodus', category: 'broadway' };
  const westEnd = { id: 'mexodus-west-end-2025', title: 'Mexodus', category: 'west-end' };
  const shows = [offB, bway, westEnd, mexTour];
  const withArt = id => ({ ...mexTour, images: { poster: img(id) } });
  for (const ok of [mexTour.id, offB.id, bway.id]) assert.deepEqual(tourImageProblems(withArt(ok), shows), [], ok);
  const bad = tourImageProblems(withArt(westEnd.id), shows);
  assert.equal(bad.length, 1, 'a West End production is not this Off-Broadway tour\'s art source');
  assert.match(bad[0], /mexodus-west-end-2025/);
  assert.equal(tourImageProblems(withArt('six-2019'), shows).length, 1);
  // With a West End parent, the West End production is allowed.
  assert.deepEqual(tourImageProblems({ ...withArt(westEnd.id), tourOf: westEnd.id }, shows), []);
  // A standalone tour: its own art, or a same-title Broadway show's.
  const lone = { id: 'elf-tour-2026', title: 'Elf', category: 'tour', images: { poster: img('elf-tour-2026') } };
  assert.deepEqual(tourImageProblems(lone, [lone]), []);
  assert.equal(tourImageProblems({ ...lone, images: { poster: img('elf-2010') } }, [lone]).length, 1);
});

test('toursOfTitle matches a standalone tour on its own title; productionsOfTitle never returns tours', () => {
  const lone = { id: 'elf-tour-2026', title: 'Elf!', category: 'tour', tourScheduleSlug: 'elf' };
  const elf = { id: 'elf-2010', title: 'Elf', category: 'broadway' };
  assert.deepEqual(toursOfTitle('Elf', [lone, elf]).map(s => s.id), ['elf-tour-2026']);
  assert.deepEqual(productionsOfTitle('ELF', [lone, elf]).map(s => s.id), ['elf-2010']);
  assert.equal(runningTourFor(elf, [lone, elf], NOW), 'elf-tour-2026');
});

test('tourLinkProblems: tourOf is optional, but a present one must exist and not be a tour', () => {
  const shows = [offB, mexTour];
  const errs = (tour, all = shows) => tourLinkProblems(tour, all).filter(p => p.level === 'error').map(p => p.msg);
  const warns = (tour, all = shows) => tourLinkProblems(tour, all).filter(p => p.level === 'warn').map(p => p.msg);
  assert.deepEqual(tourLinkProblems(mexTour, shows), [], 'a tour of an Off-Broadway show is valid');
  assert.match(errs({ ...mexTour, tourOf: 'nope-2020' })[0], /does not reference an existing show/);
  assert.match(errs({ ...mexTour, tourOf: 'mexodus-tour-2026' })[0], /is itself a tour/);
  assert.match(errs({ ...mexTour, tourOf: null })[0], /empty tourOf/);
  assert.match(errs({ ...mexTour, tourOf: '' })[0], /empty tourOf/);
  assert.match(errs({ ...mexTour, id: 'mexodus-off-broadway-tour-2026' })[0], /market before -tour-<year>/);
  // Standalone: needs the schedule slug; warns when a same-title production exists.
  const lone = { id: 'elf-tour-2026', title: 'Elf', category: 'tour', tourScheduleSlug: 'elf' };
  assert.deepEqual(tourLinkProblems(lone, [lone]), []);
  assert.match(errs({ ...lone, tourScheduleSlug: undefined }, [lone])[0], /no tourOf and no tourScheduleSlug/);
  const elf = { id: 'elf-2010', title: 'Elf', category: 'broadway' };
  assert.deepEqual(errs(lone, [lone, elf]), []);
  assert.match(warns(lone, [lone, elf])[0], /elf-2010/);
  assert.deepEqual(tourLinkProblems(elf, [elf]), [], 'non-tours are not this check\'s business');
});

test('toursOfTitle ignores apostrophe style: a straight-quote page title finds a curly-quote tour (BRO-4931)', () => {
  const shows = [
    { id: 'dolly-tour', title: 'Dolly Parton\u2019s Smoky Mountain Christmas Carol', category: 'tour', market: 'tour' },
    { id: 'seuss-tour', title: 'Dr. Seuss\u2019 The Cat in the Hat', category: 'tour', market: 'tour' },
  ];
  assert.deepEqual(toursOfTitle("Dolly Parton's Smoky Mountain Christmas Carol", shows).map(s => s.id), ['dolly-tour']);
  assert.deepEqual(toursOfTitle("Dr. Seuss' The Cat in the Hat", shows).map(s => s.id), ['seuss-tour']);
  assert.deepEqual(toursOfTitle('Dr. Seuss The Grinch', shows), []);
});
