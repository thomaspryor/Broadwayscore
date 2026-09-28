import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pickTourForDate, tourWindows, toursOfTitle, runningTourFor } = require('./tour-family.js');
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
  const parent = { id: 'p', images: { hero: '/images/shows/p/hero.webp', thumbnail: '/images/shows/p/thumbnail.webp', poster: 'https://cdn.example.com/p.jpg' }, synopsis: 'Story.' };
  const tour = { id: 't', category: 'tour', tourOf: 'p', images: { hero: null, thumbnail: null, poster: null } };
  assert.deepEqual(tourInheritance(tour, parent), { images: { hero: null, thumbnail: '/images/shows/p/thumbnail.webp', poster: null }, synopsis: 'Story.' });
  const own = { ...tour, images: { thumbnail: '/images/shows/t/thumbnail.webp' }, synopsis: 'Tour story.' };
  assert.equal(tourInheritance(own, { ...parent, images: { thumbnail: '/images/shows/p/thumbnail.webp' } }), null, 'own art and synopsis win');
  assert.equal(tourInheritance({ id: 'b', category: 'broadway' }, parent), null);
  const shows = [parent, tour];
  assert.deepEqual(applyTourInheritance(shows), ['t']);
  assert.equal(shows[1].images.thumbnail, '/images/shows/p/thumbnail.webp');
  assert.deepEqual(applyTourInheritance(shows), [], 'idempotent');
});
