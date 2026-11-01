// ingest-publish-date.js: the publish date ingest-review-from-url.js stores
// (BRO-6588). Page metadata first, then the collector's body-byline fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveIngestPublishDate } = require('./ingest-publish-date.js');

const URL_ = 'https://www.thewrap.com/a-few-good-men-broadway-review-sean-hayes/';
const body = (s) => `${s} ${'The production holds the courtroom tension well. '.repeat(10)}`;

test('a page whose JSON-LD has datePublished fills publishDate', () => {
  const html = `<html><head><script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org', '@type': 'NewsArticle', headline: 'Review', datePublished: '2026-10-29T20:00:00-04:00',
  })}</script></head><body><p>x</p></body></html>`;
  const r = resolveIngestPublishDate({ html, url: URL_, text: body('x') });
  assert.equal(r.from, 'page');
  assert.match(String(r.publishDate), /^2026-10-29/);
});

test('an explicit --publish-date wins over the page', () => {
  const r = resolveIngestPublishDate({ publishDateArg: '2026-10-30', html: '<html></html>', url: URL_, text: '' });
  assert.equal(r.publishDate, '2026-10-30');
  assert.equal(r.from, 'arg');
});

test('no page date: the body byline fills it, marked text-regex', () => {
  const r = resolveIngestPublishDate({ html: '<html><body></body></html>', url: URL_, text: body('By Critic | October 29, 2026 @ 8:00 PM') });
  assert.equal(r.from, 'text');
  assert.equal(r.dateSource, 'text-regex');
  assert.match(String(r.publishDate), /^2026-10-29/);
});

test('a body date that conflicts with the url date is not used', () => {
  const r = resolveIngestPublishDate({ html: '<html></html>', url: 'https://example.com/2024/03/02/show-review/', text: body('October 29, 2026') });
  assert.equal(r.publishDate, null);
});

test('nothing to go on gives null', () => {
  const r = resolveIngestPublishDate({ html: '<html></html>', url: URL_, text: 'short' });
  assert.equal(r.publishDate, null);
});

// BRO-6742: Lighting & Sound America pages have no date, only a venue in the headline.
const { headlineVenueDate, headlineVenue } = require('./ingest-publish-date.js');
const lsa = (h) => `<html><head><title>Theatre in Review: ${h} - Lighting&amp;Sound America Online - News</title></head><body></body></html>`;
const LSA = 'http://www.lightingandsoundamerica.com/news/story.asp?ID=TCKSKA';

test('LSA headline naming this show and its theatre dates the review to opening night', () => {
  const r = resolveIngestPublishDate({ html: lsa('Giant (Music Box Theatre)'), url: LSA, text: 'x'.repeat(2000),
    showOpeningDate: '2026-03-23', showTitle: 'Giant', showVenue: 'Music Box Theatre', otherVenues: ['Royal Court', 'Harold Pinter Theatre', 'The Public Theater'] });
  assert.equal(r.publishDate, '2026-03-23');
  assert.equal(r.from, 'venue');
});

test('venue names that differ in form still match on the distinctive word; subtitled titles match', () => {
  assert.equal(headlineVenueDate(lsa('Marjorie Prime (Second Stage/Hayes Theater)'), { showTitle: 'Marjorie Prime', showVenue: 'Helen Hayes Theater', showOpeningDate: '2025-12-08' }), '2025-12-08');
  assert.equal(headlineVenue(lsa('Two Strangers (Carry a Cake Across New York) (Longacre Theatre)')), 'Longacre Theatre');
  assert.equal(headlineVenueDate(lsa('Two Strangers (Carry a Cake Across New York) (Longacre Theatre)'),
    { showTitle: 'Two Strangers (Carry a Cake Across New York)', showVenue: 'Longacre Theatre', showOpeningDate: '2025-11-20' }), '2025-11-20');
  assert.equal(headlineVenueDate(lsa('Oedipus (Studio 54)'), { showTitle: 'Oedipus', showVenue: 'Studio 54', showOpeningDate: '2025-11-13' }), '2025-11-13');
});

test('a headline naming another show at the same theatre is not dated', () => {
  assert.equal(headlineVenueDate(lsa('Some Other Show (Music Box Theatre)'), { showTitle: 'Giant', showVenue: 'Music Box Theatre', showOpeningDate: '2026-03-23' }), null);
});

test('common venue words alone do not match', () => {
  const o = { showTitle: 'Hamlet', showOpeningDate: '2026-01-01' };
  assert.equal(headlineVenueDate(lsa('Hamlet (New World Stages)'), { ...o, showVenue: 'New York City Center' }), null);
  assert.equal(headlineVenueDate(lsa('Hamlet (The Old Globe)'), { ...o, showVenue: 'The Old Vic' }), null);
  assert.equal(headlineVenueDate(lsa('Hamlet (Theatre in the Round)'), { ...o, showVenue: 'Circle in the Square Theatre' }), null);
});

test('a subtitle read as the venue does not match', () => {
  assert.equal(headlineVenueDate(lsa('Two Strangers (Carry a Cake Across New York)'), { showTitle: 'Two Strangers', showVenue: 'New York Theatre Workshop', showOpeningDate: '2025-11-20' }), null);
});

test('a headline naming a prior production\'s theatre is not dated', () => {
  assert.equal(headlineVenueDate(lsa('Oedipus (The Old Vic)'), { showTitle: 'Oedipus', showVenue: 'Studio 54', showOpeningDate: '2025-11-13', otherVenues: ["Wyndham's Theatre", 'The Old Vic'] }), null);
});

test('a revival in the same theatre as an earlier run stays undated', () => {
  assert.equal(headlineVenueDate(lsa('Cabaret (Studio 54)'), { showTitle: 'Cabaret', showVenue: 'Studio 54', showOpeningDate: '2024-04-21', otherVenues: ['Studio 54'] }), null);
});

test('a page without the LSA headline shape is not dated by venue', () => {
  assert.equal(headlineVenueDate('<html><title>Giant (Music Box Theatre)</title></html>', { showTitle: 'Giant', showVenue: 'Music Box Theatre', showOpeningDate: '2026-03-23' }), null);
});
