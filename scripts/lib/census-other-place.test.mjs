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
    assert.equal(acceptSerpCensusResult({ url, title: 'King Lear review', snippet: 'review' }, { show: lear, showInfo: {} }), null, url);
  }
  // Chicago regional outlets (Babes with Blades) through the registry path
  for (const url of ['https://chicagoreader.com/performing-arts/theater/theater-review/king-lear-babes-with-blades/',
    'https://thirdcoastreview.com/stages/2026/10/26/review-babes-with-blades-king-lear']) {
    assert.equal(acceptSerpCensusResult({ url, title: 'King Lear review', snippet: 'review' }, { show: lear, showInfo: {} }), null, url);
  }
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
  ];
  for (const [url, show] of keep) assert.equal(censusOtherPlaceSignal(url, '', show, null), null, url);
});

test('named houses and edition paths fire; New York or the venue in the slug vetoes', () => {
  const six = { title: 'Six', venue: 'Lena Horne Theatre', category: 'broadway' };
  assert.equal(censusOtherPlaceSignal('https://www.nytimes.com/2019/06/02/theater/six-musical-chicago-next-to-normal.html', '', six, null).signal, 'place-in-slug');
  assert.equal(censusOtherPlaceSignal('https://www.timeout.com/london/theatre/waitress-review', '', { title: 'Waitress', category: 'broadway' }, null).signal, 'place-in-slug');
  assert.equal(censusOtherPlaceSignal('https://example.com/royal-court-hit-arrives-on-broadway-review', '', { title: 'Cable Street', category: 'off-broadway' }, null), null);
  assert.equal(censusOtherPlaceSignal('https://example.com/review-king-lear-secret-theatre-royal-exchange-alum', '', lear, null), null);
});

test('regional outlets: small, no New York coverage fires; covering New York or a big paper does not', () => {
  const url = 'https://example.org/review-king-lear';
  const chicago = { displayName: 'Chicago Reader', region: 'chicago', tier: 3, nyReviewCount: 0 };
  assert.equal(censusOtherPlaceSignal(url, '', lear, chicago).signal, 'regional-outlet');
  assert.equal(censusOtherPlaceSignal(url, '', lear, { ...chicago, nyReviewCount: 22 }), null); // Arts Fuse class
  assert.equal(censusOtherPlaceSignal(url, '', lear, { ...chicago, tier: 1 }), null); // LA Times / Chicago Tribune class
  assert.equal(censusOtherPlaceSignal(url, '', lear, { ...chicago, standingMarkets: ['broadway'] }), null);
  assert.equal(censusOtherPlaceSignal(url, '', lear, { ...chicago, region: 'london' }), null);
});

test('scope: London shows, declared prior runs and the kill switch never fire', () => {
  const url = 'https://www.theguardian.com/stage/2026/oct/10/king-lear-review-royal-exchange-theatre-manchester';
  assert.equal(censusOtherPlaceSignal(url, '', { ...lear, category: 'west-end' }, null), null);
  assert.equal(censusOtherPlaceSignal(url, '', { ...lear, priorRuns: [{ venue: 'Royal Exchange' }] }, null), null);
  process.env.CENSUS_OTHER_PLACE_DISABLED = '1';
  try { assert.equal(censusOtherPlaceSignal(url, '', lear, null), null); } finally { delete process.env.CENSUS_OTHER_PLACE_DISABLED; }
});
