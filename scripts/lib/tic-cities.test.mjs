// BRO-6771: Theatre In DC rides the Theatre In Chicago code path through a city config.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { getCity, cityForUrl, CITIES } = require('./tic-cities.js');
const stage = require('./tic-stage.js');
const tic = require('./theatreinchicago.js');
const { ticIdOf, runDaily } = require('./tic-daily.js');
const { resolveMetro } = require('./venue-metro.js');

const dc = getCity('dc');
const rev = (o, u) => ({ outlet: o, url: u });
const mkPage = (over = {}) => ({
  id: 5280, slug: 'all-the-worlds-a-stage', empty: false, title: "All The World's A Stage", venue: 'Signature Theatre',
  closingDate: '2026-12-20', poster: null,
  reviews: [rev('A', 'http://a/1'), rev('B', 'http://b/1'), rev('C', 'http://c/1')], ...over,
});
const detailFor = (address, venue = 'Signature Theatre', showType = 'Musical') => ({ empty: false, title: 'x', venue, address, showType, closingDate: '2026-12-20' });

test('getCity: defaults to chicago, rejects unknown keys, finds a city by url', () => {
  assert.equal(getCity().key, 'chicago');
  assert.throws(() => getCity('atlantis'), /unknown city/);
  assert.equal(cityForUrl('https://www.theatreindc.com/x/1/').key, 'dc');
  assert.equal(cityForUrl('https://example.com/'), null);
});

test('every configured metro is a real venue-metros place', () => {
  for (const c of Object.values(CITIES)) {
    if (!c.venueCities) continue;
    for (const [name, st] of c.venueCities) assert.equal(resolveMetro(`Some Theatre, ${name}, ${st}`), c.metro, `${name}, ${st}`);
  }
});

test('DC venueLine reads the city off a bare address and names DC properly', () => {
  assert.equal(stage.venueLine(detailFor('4200 Campbell Avenue Arlington'), {}, dc), 'Signature Theatre, Arlington, VA');
  assert.equal(stage.venueLine(detailFor('1101 6th Street SW Washington', 'Arena Stage'), {}, dc), 'Arena Stage, Washington, DC');
  assert.equal(stage.venueLine(detailFor('315 W Fayette St Baltimore', 'Everyman Theatre'), {}, dc), null);
});

test('DC detailFilter: Baltimore and Columbia are outside the metro, Olney is inside', () => {
  assert.equal(stage.detailFilter(detailFor('315 W Fayette St Baltimore', 'Everyman Theatre'), mkPage(), dc).reason, 'outside-metro');
  assert.equal(stage.detailFilter(detailFor('10901 Little Patuxent Pkwy Columbia', 'Toby'), mkPage(), dc).reason, 'outside-metro');
  assert.equal(stage.detailFilter(detailFor('2001 Olney Sandy Spring Road Olney', 'Olney Theatre Center'), mkPage(), dc).ok, true);
});

test('DC prefilter: tour houses and runs that closed before 2026-05-01 are dropped', () => {
  assert.equal(stage.prefilter(mkPage({ venue: 'Kennedy Center Opera House' }), dc).reason, 'tour-house');
  assert.equal(stage.prefilter(mkPage({ closingDate: '2026-04-30' }), dc).reason, 'before-since');
  assert.equal(stage.prefilter(mkPage({ closingDate: '2026-05-01' }), dc).ok, true);
  // Chicago has no cutoff.
  assert.equal(stage.prefilter(mkPage({ closingDate: '2020-01-01', venue: 'Steppenwolf' })).ok, true);
});

test('DC buildShowEntry: theatreindc source, washington-dc city, own evidence url', () => {
  const e = stage.buildShowEntry({ page: mkPage(), detail: detailFor('4200 Campbell Avenue Arlington'), dates: { openingDate: '2026-10-02' }, discoveredAt: '2026-11-01', city: dc });
  assert.equal(e.discoverySource, 'theatreindc');
  assert.equal(e.city, 'washington-dc');
  assert.equal(e.localOnly, true);
  assert.equal(e.venue, 'Signature Theatre, Arlington, VA');
  assert.deepEqual(e.evidenceUrls, ['https://www.theatreindc.com/all-the-worlds-a-stage/5280/']);
  assert.equal(resolveMetro(e.venue), e.city);
});

test('ticIdOf only reads ids from the requested city host', () => {
  const show = { evidenceUrls: ['https://www.theatreindc.com/a/5280/'] };
  assert.equal(ticIdOf(show, dc), 5280);
  assert.equal(ticIdOf(show), null);
});

test('reviews pages parse links against the city base', () => {
  const html = '<div class="single-review"><div class="post-content"><h3 class="section-title"><a>T</a></h3></div><div class="reviews"><div class="review"><p class="pub"><span class="bodyBold">Out -</span> Highly</p><p class="review">"x"</p><div class="review-bottom"><a href="/local/path">r</a></div></div></div></div>';
  const p = tic.parseReviewsPage(html, 1, 'https://www.theatreindc.com');
  assert.equal(p.reviews[0].url, 'https://www.theatreindc.com/local/path');
});

test('runDaily (DC): adds an open in-metro show, rejects one that opened before the cutoff and closed', async () => {
  const pages = { 1: mkPage({ id: 1 }), 2: mkPage({ id: 2, title: 'Old Play', closingDate: '2026-06-01' }) };
  const io = {
    page: async (id) => pages[id],
    detail: async (pg) => ({ ...detailFor('4200 Campbell Avenue Arlington'), closingDate: pg.closingDate }),
    dates: async (pg) => (pg.id === 1 ? { openingDate: '2026-10-02' } : { openingDate: '2026-04-10' }),
  };
  const shows = [];
  const out = await runDaily({ listing: [{ id: 1, reviewCount: 3 }, { id: 2, reviewCount: 3 }], shows, seen: {}, today: '2026-11-01', io, city: dc });
  assert.equal(out.added.length, 1);
  assert.equal(shows[0].city, 'washington-dc');
  assert.equal(out.seen[2].reason, 'before-since');
  assert.equal(out.seen[2].retry, false);
});
