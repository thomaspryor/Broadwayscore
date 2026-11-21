import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isPlaceholderUrl, todaytixArt, stopEventPages, pageImageUrls, rolesForSize, rolesNeeded, archivedUnreferenced } = require('./tour-art.js');

test('archivedUnreferenced: own file on disk but shows.json still inherits', () => {
  const tour = { id: 'x-tour-2026', images: { poster: '/images/shows/x-2024/poster.webp', thumbnail: '/images/shows/x-2024/thumbnail.webp' } };
  const onDisk = new Set(['/images/shows/x-2024/poster.webp', '/images/shows/x-2024/thumbnail.webp', '/images/shows/x-tour-2026/thumbnail.webp']);
  const src = { thumbnail: 'https://example.com/t.jpg' };
  assert.deepEqual(archivedUnreferenced(tour, p => onDisk.has(p), src), ['thumbnail']);
  assert.deepEqual(archivedUnreferenced(tour, p => onDisk.has(p), { thumbnailCroppedFrom: 'https://example.com/b.jpg' }), ['thumbnail']);
  // a file with no verified source on record is never adopted
  assert.deepEqual(archivedUnreferenced(tour, p => onDisk.has(p)), []);
  assert.deepEqual(archivedUnreferenced(tour, p => onDisk.has(p), { poster: 'https://example.com/p.jpg' }), []);
  // already referenced: nothing to adopt
  const done = { id: 'x-tour-2026', images: { ...tour.images, thumbnail: '/images/shows/x-tour-2026/thumbnail.webp' } };
  assert.deepEqual(archivedUnreferenced(done, p => onDisk.has(p), src), []);
  // no own file: nothing to adopt
  assert.deepEqual(archivedUnreferenced(tour, () => false, src), []);
});

const NOW = new Date('2026-10-05T00:00:00Z');
const CF = '//images.ctfassets.net/6pezt69ih962';

test('TodayTix "Coming soon" cards are placeholders (NORAM_/Poster_480x720 render as Coming soon)', () => {
  assert.equal(isPlaceholderUrl(`${CF}/a/b/NORAM_480x720.jpg`), true);
  assert.equal(isPlaceholderUrl(`${CF}/a/b/Poster_480x720.jpg`), true);
  assert.equal(isPlaceholderUrl(`${CF}/a/b/ComingSoon_480x720.jpg`), true);
  assert.equal(isPlaceholderUrl(null), true);
  assert.equal(isPlaceholderUrl(`${CF}/a/b/C6-MARY-TT-480x720.jpg`), false);
  assert.equal(isPlaceholderUrl(`${CF}/a/b/ATG_Waitress_Ttix_v1_480_x_720.jpg`), false);
});

const tour = { id: 'oh-mary-tour-2026', title: 'Oh, Mary!' };
const schedules = { 'oh-mary-tour-2026': { stops: [
  { city: 'Los Angeles, CA', venue: 'Ahmanson Theatre', start: '2026-11-10' },
  { city: 'Washington, DC', venue: 'National Theatre', start: '2027-02-09' },
] } };
const listing = (id, o) => ({ id, slug: 'oh-mary', displayName: 'Oh, Mary!', areRegularTicketsAvailable: true, ...o });

test('todaytixArt takes art only from listings matched to a stop, and drops placeholders', () => {
  const rows = [
    listing(1, { _locationId: 5, venue: 'Center Theatre Group at the Ahmanson Theatre', startDate: '2026-11-10', posterImageUrl: `${CF}/x/y/C6-MARY-TT-480x720.jpg`, posterImageSquareUrl: `${CF}/x/y/sq.jpg` }),
    listing(2, { _locationId: 6, venue: 'The National Theatre - Washington DC', startDate: '2027-02-09', posterImageUrl: `${CF}/x/y/ComingSoon_480x720.jpg`, posterImageSquareUrl: `${CF}/x/y/ComingSoon_square.jpg` }),
    // A local production of the title on another date matches no stop.
    listing(3, { _locationId: 3, venue: 'Marriott Theatre', startDate: '2026-12-01', posterImageUrl: `${CF}/x/y/local.jpg` }),
  ];
  const art = todaytixArt(rows, [tour], schedules, NOW);
  assert.equal(art[tour.id].length, 1);
  assert.equal(art[tour.id][0].poster, `https:${CF}/x/y/C6-MARY-TT-480x720.jpg`);
  assert.equal(art[tour.id][0].thumbnail, `https:${CF}/x/y/sq.jpg`);
});

test('todaytixArt gives nothing to a tour with no stop schedule', () => {
  const rows = [listing(1, { _locationId: 5, venue: 'Ahmanson Theatre', startDate: '2026-11-10', posterImageUrl: `${CF}/x/y/a.jpg` })];
  assert.deepEqual(todaytixArt(rows, [tour], {}, NOW), {});
});

const ttyRow = (city, venue, dates, tickets) => `<tr class="row-3"><td class="column-1">${city}</td><td class="column-2"><a href="https://tourstoyou.org/resources/venues/x/">${venue}</a></td><td class="column-3">${dates}</td><td class="column-4">${tickets ? `<a href="${tickets}" target="_blank">Tickets</a>` : ''}</td></tr>`;

test('stopEventPages keeps Tickets links of rows that are this tour\'s stops, upcoming first', () => {
  const html = `<table>${[
    ttyRow('Hartford, CT', 'The Bushnell', 'March 3-8, 2026', 'https://www.bushnell.org/events/detail/old-run'),
    ttyRow('Alto, NM', 'Spencer Theater', 'January 28-29, 2027', 'https://spencertheater.com/mark-twain-tonight-1'),
    ttyRow('Hartford, CT', 'The Bushnell', 'November 3-8, 2026', 'https://www.bushnell.org/events/detail/mark-twain-tonight'),
    ttyRow('Albuquerque, NM', 'Popejoy Hall', 'January 31, 2027', null),
    ttyRow('Des Moines, IA', 'Civic Center', 'February 2, 2027', 'https://ticketmaster.evyy.net/c/1?u=x'),
  ].join('')}</table>`;
  const stops = [
    { city: 'Hartford, CT', start: '2026-11-03' },
    { city: 'Alto, NM', start: '2027-01-28' },
    { city: 'Albuquerque, NM', start: '2027-01-31' },
    { city: 'Des Moines, IA', start: '2027-02-02' },
  ];
  assert.deepEqual(stopEventPages(html, stops, NOW).map(p => p.url), [
    'https://www.bushnell.org/events/detail/mark-twain-tonight',
    'https://spencertheater.com/mark-twain-tonight-1',
  ]);
});

test('pageImageUrls reads og:image, twitter:image and JSON-LD Event images, not body imgs', () => {
  const html = `<head>
    <meta property="og:image" content="/assets/img/MTT_12x12_admat_square.jpg">
    <meta name="twitter:image" content="https://cdn.example.com/tw.jpg">
    <script type="application/ld+json">{"@type":"TheaterEvent","image":["https://cdn.example.com/ld.jpg"]}</script>
    <script type="application/ld+json">{"@type":"Organization","image":"https://cdn.example.com/logo.png"}</script>
  </head><body><img src="https://cdn.example.com/other-show.jpg"></body>`;
  assert.deepEqual(pageImageUrls(html, 'https://www.bushnell.org/events/detail/mtt'), [
    'https://www.bushnell.org/assets/img/MTT_12x12_admat_square.jpg',
    'https://cdn.example.com/tw.jpg',
    'https://cdn.example.com/ld.jpg',
  ]);
});

test('rolesForSize: landscape and tiny images fill nothing, square art is thumbnail only', () => {
  assert.deepEqual(rolesForSize(480, 720), ['poster', 'thumbnail']);
  // A square poster is cropped to "s. Doubtf" in the 2:3 show-page frame.
  assert.deepEqual(rolesForSize(540, 540), ['thumbnail']);
  assert.deepEqual(rolesForSize(600, 800), ['thumbnail']);
  assert.deepEqual(rolesForSize(1200, 630), []);
  assert.deepEqual(rolesForSize(200, 300), []);
  assert.deepEqual(rolesForSize(400, 800), ['poster']);
});

test('rolesNeeded: inherited Broadway art is open for the tour\'s own; its own files are kept', () => {
  const t = { id: 'kinky-boots-tour-2025', images: { poster: '/images/shows/kinky-boots-2013/poster.jpg', thumbnail: '/images/shows/kinky-boots-tour-2025/thumbnail.webp' } };
  assert.deepEqual(rolesNeeded(t), ['poster']);
  assert.deepEqual(rolesNeeded(t, () => false), ['poster', 'thumbnail']);
  assert.deepEqual(rolesNeeded({ id: 'x-tour-2027' }), ['poster', 'thumbnail']);
});

test('landscapeCroppable: social banners yes, panoramas and tiny images no', () => {
  const { landscapeCroppable } = require('./tour-art.js');
  assert.equal(landscapeCroppable(1200, 630), true);
  assert.equal(landscapeCroppable(1920, 1080), true);
  assert.equal(landscapeCroppable(3000, 600), false);
  assert.equal(landscapeCroppable(500, 280), false);
  assert.equal(landscapeCroppable(480, 720), false);
});

test('descriptionNamesTitle needs every distinctive title word in the verdict', () => {
  const { descriptionNamesTitle } = require('./tour-art.js');
  assert.equal(descriptionNamesTitle('Promotional art for "SIX" with six queens', 'SIX'), true);
  assert.equal(descriptionNamesTitle('Key art for The Sound of Music tour', 'The Sound of Music'), true);
  assert.equal(descriptionNamesTitle('A woman in a diner uniform holding a pie', 'Waitress'), false);
  assert.equal(descriptionNamesTitle('Logo for Hamilton', 'Hamilton: An American Musical'), false);
  assert.equal(descriptionNamesTitle('Poster for Hamilton, An American Musical', 'Hamilton: An American Musical'), true);
});

test('retryDue backs a tour with no findable art off for RETRY_DAYS', () => {
  const { retryDue, RETRY_DAYS } = require('./tour-art.js');
  assert.equal(RETRY_DAYS, 7);
  assert.equal(retryDue(undefined, NOW), true);
  assert.equal(retryDue({ triedAt: '2026-10-01T08:00:00Z' }, NOW), false);
  assert.equal(retryDue({ triedAt: '2026-09-27T08:00:00Z' }, NOW), true);
  assert.equal(retryDue({ triedAt: 'garbage' }, NOW), true);
});

test('cropAllowed: a centre crop only fills a tour with no thumbnail', () => {
  const { cropAllowed } = require('./tour-art.js');
  assert.equal(cropAllowed({ id: 'x-tour-2027' }), true);
  assert.equal(cropAllowed({ id: 'x-tour-2027', images: { poster: '/p.webp', thumbnail: null } }), true);
  assert.equal(cropAllowed({ id: 'hamilton-tour-2024', images: { thumbnail: '/images/shows/hamilton-2015/thumbnail.webp' } }), false);
});

test('attemptAction: back off after any real search that leaves a role unfilled, never on Gemini errors', () => {
  const { attemptAction } = require('./tour-art.js');
  const both = ['poster', 'thumbnail'];
  assert.equal(attemptAction({ need: both, written: both, searched: true }), 'clear');
  // thumbnail only (Mrs. Doubtfire's square poster): poster waits a week
  assert.equal(attemptAction({ need: both, written: ['thumbnail'], searched: true }), 'backoff');
  assert.equal(attemptAction({ need: both, searched: true }), 'backoff');
  // no schedule yet: try again the day it arrives
  assert.equal(attemptAction({ need: both, searched: false }), 'keep');
  // Gemini 500s: try again tomorrow
  assert.equal(attemptAction({ need: both, written: ['thumbnail'], searched: true, transient: true }), 'keep');
  // a transient error elsewhere does not block clearing a full success
  assert.equal(attemptAction({ need: ['poster'], written: ['poster'], searched: true, transient: true }), 'clear');
});
