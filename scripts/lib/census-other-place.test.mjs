// BRO-7129: the SERP census must not count other cities' stagings of a classic title
// as "known" reviews of a New York show (King Lear Off-Broadway, 2026-11-05).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { censusOtherPlaceSignal } = require('./census-other-place');
const { acceptSerpCensusResult } = require('../audit-show-review-gap');

const lear = { id: 'king-lear-off-broadway-2026', title: 'King Lear', category: 'off-broadway', venue: 'The Secret Theatre', openingDate: '2026-11-05' };

const LEAR_OTHER_PRODUCTIONS = [
  'https://www.outalldaynola.com/new-orleans-weekly-news/first-night-review-king-lear-the-lupin-theater',
  'https://www.theatretradge.com/post/review-king-lear-royal-exchange-theatre-08-10-26',
  'https://www.londontheatre.co.uk/reviews/review-king-lear-starring-ian-mckellen-at-the-duke-of-yorks-theatre',
  'https://familyaffairsandothermatters.com/king-lear-review-richmond-theatre/',
  'https://jadar.uk/2026/10/11/review-king-lear-royal-exchange-theatre/',
  'https://www.theguardian.com/stage/2026/oct/10/king-lear-review-david-threlfall-royal-exchange-theatre-manchester',
];

test('King Lear OB: every other-city staging the census counted is refused by the real census gate', () => {
  for (const url of LEAR_OTHER_PRODUCTIONS) {
    // the new guard fires on each one by itself (not only the older .uk-host guard)
    assert.ok(censusOtherPlaceSignal(url, 'King Lear review', lear, null), url);
    assert.equal(acceptSerpCensusResult({ url, title: 'King Lear review', snippet: 'review' }, { show: lear, showInfo: {} }), null, url);
  }
  // Chicago Reader (Babes with Blades) through the registry path: a Chicago outlet with no
  // live New York review. (Third Coast Review has 2 live New York reviews, so it keeps its rows.)
  const reader = 'https://chicagoreader.com/performing-arts/theater/theater-review/king-lear-babes-with-blades/';
  assert.equal(acceptSerpCensusResult({ url: reader, title: 'King Lear review', snippet: 'review' }, { show: lear, showInfo: {} }), null);
  process.env.CENSUS_OTHER_PLACE_DISABLED = '1';
  try {
    assert.ok(acceptSerpCensusResult({ url: reader, title: 'King Lear review', snippet: 'review' }, { show: lear, showInfo: {} }), 'without the guard the Chicago row was counted');
  } finally { delete process.env.CENSUS_OTHER_PLACE_DISABLED; }
});

test('a New York review of the same show is still accepted', () => {
  const url = 'https://www.nystagereview.com/2026/11/06/king-lear-at-the-secret-theatre-review/';
  assert.ok(acceptSerpCensusResult({ url, title: 'King Lear review', snippet: 'review' }, { show: lear, showInfo: {} }));
  assert.equal(censusOtherPlaceSignal('https://www.timeout.com/newyork/theater/king-lear-review-queens', '', lear, null), null);
});

test('place words that describe the show, not where it is staged, do not fire', () => {
  const ob = (title, venue = 'Some Theater') => ({ title, venue, category: 'off-broadway' });
  const keep = [
    ['https://www.nystagereview.com/2019/09/05/betrayal-less-is-more-in-this-london-born-revival/', ob('Betrayal')],
    ['https://www.theatermania.com/news/review-london-hit-cable-street-thrills-but-rarely-steps-out-of-hamiltons-shadow_1835402/', ob('Cable Street')],
    ['https://www.villagevoice.com/2018/05/29/with-paradise-blue-dominique-morisseau-applies-a-steamy-noir-sheen-to-1949-detroit/', ob('Paradise Blue')],
    ['https://www.nystagereview.com/2018/05/14/paradise-blue-race-music-and-madness-in-detroit/', ob('Paradise Blue')],
    ['https://newyorktheater.me/2016/12/06/rancho-viejo-review-life-in-the-california-suburbs/', ob('Rancho Viejo')],
    ['https://caroleditosti.com/2017/06/25/the-traveling-lady-by-horton-foote-directed-by-austin-pendleton/', ob('The Traveling Lady')],
    ['https://www.wsj.com/articles/the-traveling-lady-and-marvins-room-reviews-from-texas-to-the-hospital-1498782601', ob('The Traveling Lady')],
    ['https://t2conline.com/broadways-life-of-pi-sails-strong-and-magically-over-from-the-west-end/', { title: 'Life of Pi', venue: 'Schoenfeld', category: 'broadway' }],
    ['https://frontmezzjunkies.com/2019/10/20/steppenwolf-second-stage-linda-vista/', { title: 'Linda Vista', venue: 'Hayes Theater', category: 'broadway' }],
    // the show's own title is a city
    ['https://www.nytimes.com/1996/11/15/theater/chicago-review.html', { title: 'Chicago', venue: 'Ambassador Theatre', category: 'broadway' }],
    // a city that starts a slug without being the whole segment (ship-check review)
    ['https://www.theatermania.com/news/london-transplant-the-ferryman-is-a-triumph_1234/', ob('The Ferryman')],
    ['https://www.theatermania.com/news/london-hit-the-ferryman-arrives/', ob('The Ferryman')],
    ['https://www.bloomberg.com/news/2010-11-01/-chicago-duo-zaps-racist-trial-in-scottsboro-boys.html', ob('The Scottsboro Boys')],
    ['https://example.com/manchester-by-the-sea-author-kenneth-lonergan-new-play', ob('Hold On to Me Darling')],
    ['https://example.com/2026/the-play-london-review-of-books-critic', ob('The Play')],
    ['https://example.com/theater/oxford-review', ob('Some Play')],
    ['https://example.com/theater/blood-bath-review', ob('Blood Bath')],
  ];
  for (const [url, show] of keep) assert.equal(censusOtherPlaceSignal(url, '', show, null), null, url);
  // SERP titles: where the show came from, not where it is staged
  assert.equal(censusOtherPlaceSignal('https://example.com/prima-facie-review', 'Jodie Comer reprises her West End staging', ob('Prima Facie'), null), null);
  assert.equal(censusOtherPlaceSignal('https://example.com/the-play-review', 'The Play arrives from the West End stage', ob('The Play'), null), null);
  // a show titled with New York words keeps the New York veto
  assert.equal(censusOtherPlaceSignal('https://example.com/new-york-new-york-review-palace-theatre-london-revival', '', { title: 'New York, New York', category: 'broadway' }, null), null);
});

test('a URL already live as a review of the show is never rejected', () => {
  // Live rows (reviews.json) whose slug names only another place: the Donmar's Henry IV at
  // St. Ann's (NYT), the New Yorker's Shark Is Broken notice. The guard alone would drop them.
  const live = [
    ['https://www.nytimes.com/2015/11/12/theater/review-henry-iv-donmar-warehouses-all-female-version.html',
      { id: 'henry-iv-off-broadway-2015', title: 'Henry IV', venue: "St. Ann's Warehouse", category: 'off-broadway' }],
    ['https://www.newyorker.com/magazine/2023/08/21/the-shark-is-broken-theatre-review-west-end',
      { id: 'the-shark-is-broken-2023', title: 'The Shark Is Broken', venue: 'John Golden Theatre', category: 'broadway' }],
  ];
  for (const [url, show] of live) {
    assert.ok(censusOtherPlaceSignal(url, '', show, null), `guard alone fires: ${url}`);
    assert.ok(acceptSerpCensusResult({ url, title: `${show.title} review`, snippet: 'review' }, { show, showInfo: {} }), `live row kept: ${url}`);
  }
});

test('named houses and edition paths fire; New York or the venue in the slug vetoes', () => {
  const six = { title: 'Six', venue: 'Lena Horne Theatre', category: 'broadway' };
  assert.equal(censusOtherPlaceSignal('https://www.nytimes.com/2019/06/02/theater/six-musical-chicago-next-to-normal.html', '', six, null).signal, 'place-in-slug');
  assert.equal(censusOtherPlaceSignal('https://www.timeout.com/london/theatre/waitress-review', '', { title: 'Waitress', category: 'broadway' }, null).signal, 'place-in-slug');
  // a house noun one word after the city; a named house the city list leaves out
  assert.equal(censusOtherPlaceSignal('https://www.stlmag.com/events/st-louis-family-theatre-rosie-revere/', '', { title: 'Rosie Revere', category: 'off-broadway' }, null).signal, 'place-in-slug');
  assert.equal(censusOtherPlaceSignal('https://oxfordshireguardian.co.uk/emma-rices-tristan-yseult-returns-to-oxford-playhouse-in-january/', '', { title: 'Tristan and Yseult', category: 'off-broadway' }, null).signal, 'place-in-slug');
  assert.equal(censusOtherPlaceSignal('https://example.com/royal-court-hit-arrives-on-broadway-review', '', { title: 'Cable Street', category: 'off-broadway' }, null), null);
  assert.equal(censusOtherPlaceSignal('https://example.com/review-king-lear-secret-theatre-royal-exchange-alum', '', lear, null), null);
});

test('regional outlets: small, no New York coverage fires; covering New York or a big paper does not', () => {
  const url = 'https://example.org/review-king-lear';
  const chicago = { displayName: 'Chicago Reader', region: 'chicago', tier: 3, nyReviewCount: 0 };
  assert.equal(censusOtherPlaceSignal(url, '', lear, chicago).signal, 'regional-outlet');
  assert.equal(censusOtherPlaceSignal(url, '', lear, () => chicago).signal, 'regional-outlet'); // lazy lookup
  assert.equal(censusOtherPlaceSignal(url, '', lear, { ...chicago, nyReviewCount: 1 }), null); // Theater Mirror class
  assert.equal(censusOtherPlaceSignal(url, '', lear, { ...chicago, nyReviewCount: 22 }), null); // Arts Fuse class
  assert.equal(censusOtherPlaceSignal(url, '', lear, { ...chicago, tier: 1 }), null); // LA Times / Chicago Tribune class
  assert.equal(censusOtherPlaceSignal(url, '', lear, { ...chicago, standingMarkets: ['broadway'] }), null);
  assert.equal(censusOtherPlaceSignal(url, '', lear, { ...chicago, region: 'london' }), null);
});

test('scope: London shows, declared prior runs and the kill switch never fire', () => {
  const url = 'https://www.theguardian.com/stage/2026/oct/10/king-lear-review-royal-exchange-theatre-manchester';
  let looked = false;
  assert.equal(censusOtherPlaceSignal(url, '', { ...lear, category: 'west-end' }, () => { looked = true; return null; }), null);
  assert.equal(looked, false, 'a London show never pays for the registry lookup');
  assert.equal(censusOtherPlaceSignal(url, '', { ...lear, priorRuns: [{ venue: 'Royal Exchange' }] }, null), null);
  process.env.CENSUS_OTHER_PLACE_DISABLED = '1';
  try { assert.equal(censusOtherPlaceSignal(url, '', lear, null), null); } finally { delete process.env.CENSUS_OTHER_PLACE_DISABLED; }
});
