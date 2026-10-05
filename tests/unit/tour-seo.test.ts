/**
 * Tour SEO copy and structured data (BRO-4601 phase 2). Calls the real
 * exported functions (CLAUDE.md rule 15).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { getShowFAQs, generateItemListSchema, generateBrowseFAQSchema, tourSubEvents } from '../../src/lib/seo';
import { stopPlace } from '../../src/lib/tour-schedule';
import type { ComputedShow } from '../../src/lib/engine';

const require = createRequire(import.meta.url);
const { isTourListedSlim } = require('../../scripts/lib/search-shows-scores.js');

const tour = {
  id: 'oh-mary-tour-2026', slug: 'oh-mary-tour-2026', title: 'Oh, Mary!', category: 'tour', status: 'open',
  venue: 'North American Tour', type: 'play', openingDate: '2026-09-19',
  criticScore: { score: 90, reviewCount: 5, tier1Count: 0, tier2Count: 3, reviews: [] },
} as unknown as ComputedShow;
const nowNext = {
  now: { city: 'San Diego, CA', venue: 'Civic Theatre', start: '2026-09-29', end: '2026-10-04' },
  next: { city: 'Las Vegas, NV', venue: 'Smith Center', start: '2026-10-06', end: '2026-10-11' },
};

test('a tour FAQ says where it plays now and next, never "North American Tour"', () => {
  const faqs = getShowFAQs(tour, null, nowNext);
  const where = faqs.find(f => /playing now/.test(f.question));
  assert.ok(where, 'where-now question present');
  assert.match(where!.answer, /Civic Theatre in San Diego, CA through October 4/);
  assert.match(where!.answer, /Smith Center in Las Vegas, NV from October 6/);
  assert.ok(!faqs.some(f => /North American Tour/.test(f.answer)));
});

test('a gold tour is not called "one of the season\'s most acclaimed shows"', () => {
  const worth = getShowFAQs(tour, null, nowNext).find(f => /worth seeing/.test(f.question));
  assert.ok(worth);
  assert.doesNotMatch(worth!.answer, /season's most acclaimed/);
  assert.match(worth!.answer, /national tour/);
});

test('without a schedule a tour has no where-now question', () => {
  assert.ok(!getShowFAQs(tour, null, null).some(f => /playing now/.test(f.question)));
});

test('tours are listed by URL only in the browse ItemList (no pseudo address)', () => {
  const list = generateItemListSchema([{ name: 'Oh, Mary!', url: 'https://x/show/oh-mary-tour-2026', venue: 'North American Tour', category: 'tour' }], 'Tours');
  const item = list.itemListElement[0] as Record<string, unknown>;
  assert.equal(item['@type'], 'ListItem');
  assert.ok(!JSON.stringify(item).includes('North American Tour'));
});

test('tour browse FAQ capitalises Broadway', () => {
  const shows = ['A', 'B'].map((t, i) => ({ title: t, slug: t, category: 'tour', status: 'open', criticScore: { score: 90 - i, reviewCount: 5 } }));
  const faq = generateBrowseFAQSchema('Broadway National Tours', shows);
  const qs = (faq?.mainEntity || []).map((q: { name: string }) => q.name);
  assert.ok(qs.every((q: string) => !/broadway national tours/.test(q)), qs.join(' | '));
});

test('isTourListedSlim mirrors isTourListed: 3 reviews, or 5 when none is T1/T2', () => {
  assert.equal(isTourListedSlim({ rc: 3, rv: [{ t: 2 }, { t: 3 }, { t: 3 }] }), true);
  assert.equal(isTourListedSlim({ rc: 4, rv: [{ t: 3 }, { t: 3 }, { t: 3 }, { t: 3 }] }), false);
  assert.equal(isTourListedSlim({ rc: 2, rv: [{ t: 1 }, { t: 1 }] }), false);
  assert.equal(isTourListedSlim(null), false);
});

test('stopPlace: US state, Canadian province, Mexico, no suffix', () => {
  assert.deepEqual(stopPlace('Costa Mesa, CA'), { locality: 'Costa Mesa', region: 'CA', country: 'US' });
  assert.deepEqual(stopPlace('Toronto, ON'), { locality: 'Toronto', region: 'ON', country: 'CA' });
  assert.deepEqual(stopPlace('Saskatoon, SK'), { locality: 'Saskatoon', region: 'SK', country: 'CA' });
  assert.deepEqual(stopPlace('Mexico City, MX'), { locality: 'Mexico City', country: 'MX' });
  assert.deepEqual(stopPlace('Honolulu'), { locality: 'Honolulu', country: 'US' });
});

test('tourSubEvents: upcoming stops only, real theaters, offer only where on sale', () => {
  const stops = [
    { city: 'Los Angeles, CA', venue: 'Pantages Theatre', start: '2026-09-30', end: '2026-10-04' },
    { city: 'Toronto, ON', venue: 'Princess of Wales Theatre', start: '2026-10-06', end: '2026-10-18' },
    { city: 'Costa Mesa, CA', venue: 'Segerstrom Center', start: '2026-10-20', end: '2026-11-01' },
  ];
  const subs = tourSubEvents(tour, stops, '2026-10-05', { 'Costa Mesa, CA|2026-10-20': 'https://www.todaytix.com/los-angeles/shows/1-x' });
  assert.equal(subs.length, 2, 'the LA stop has ended');
  assert.equal(subs[0].name, 'Oh, Mary! in Toronto');
  assert.deepEqual(subs[0].location.address, { '@type': 'PostalAddress', addressLocality: 'Toronto', addressRegion: 'ON', addressCountry: 'CA' });
  assert.equal(subs[0].location['@type'], 'PerformingArtsTheater');
  assert.equal('offers' in subs[0], false);
  assert.equal((subs[1] as { offers?: { url: string } }).offers?.url, 'https://www.todaytix.com/los-angeles/shows/1-x');
  const many = Array.from({ length: 15 }, (_, i) => ({ city: 'Austin, TX', venue: 'Bass Concert Hall', start: `2027-01-${String(i + 10)}`, end: `2027-01-${String(i + 10)}` }));
  assert.equal(tourSubEvents(tour, many, '2026-10-05').length, 10);
});
