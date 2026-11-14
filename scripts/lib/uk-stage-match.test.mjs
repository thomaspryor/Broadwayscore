// BRO-6606: Stage sitemap -> UK hub show matching (real slugs from the 2026-10-31 Reviews sitemap).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { slugify, parseSitemapEntries, parseStageReviewUrl, matchEntry, matchShows } = require('./uk-stage-match.js');

const E = (slug, lastmod) => ({ url: `https://www.thestage.co.uk/reviews/${slug}`, lastmod });
const show = (id, title, venue, openingDate) => ({ id, title, venue, openingDate });

test('slugify drops accents and apostrophes', () => {
  assert.equal(slugify('Òran Mór'), 'oran-mor');
  assert.equal(slugify("Barriers: It's Murder"), 'barriers-its-murder');
});

test('parses sitemap entries and review slugs', () => {
  const xml = '<urlset><url><loc>https://www.thestage.co.uk/reviews/a-b-review-x-y</loc><lastmod>2025-01-02T00:00+00:00</lastmod></url></urlset>';
  assert.deepEqual(parseSitemapEntries(xml), [{ url: 'https://www.thestage.co.uk/reviews/a-b-review-x-y', lastmod: '2025-01-02T00:00+00:00' }]);
  assert.deepEqual(parseStageReviewUrl('https://www.thestage.co.uk/reviews/a-b-review-x-y'), { titleSlug: 'a-b', rest: 'x-y' });
  assert.equal(parseStageReviewUrl('https://www.thestage.co.uk/news/a-b'), null);
});

test('matches title, venue and run window', () => {
  const s = show('cheapo', 'Cheapo', 'Òran Mór, Glasgow', '2025-10-01');
  assert.ok(matchEntry(s, E('cheapo-review-oran-mor-glasgow-a-play-a-pie-and-a-pint', '2025-10-01T13:07+00:00')).dateOk);
});

test('rejects another venue with a shared word (Chichester Festival vs Edinburgh Festival Theatre)', () => {
  const s = show('cind', 'Cinderella', 'Chichester Festival Theatre, Chichester', '2024-12-01');
  assert.equal(matchEntry(s, E('cinderella-review-edinburgh-festival-theatre-crossroads-pantomimes', '2024-12-02T00:00+00:00')), null);
});

test('rejects the same title at another city, and out-of-window revivals', () => {
  const s = show('lsh', 'Little Shop of Horrors', 'Crucible Theatre, Sheffield', '2025-03-01');
  assert.equal(matchEntry(s, E('little-shop-of-horrors-review-hope-mill-theatre-manchester', '2025-03-02T00:00+00:00')), null);
  assert.deepEqual(Object.keys(matchShows([s], [E('little-shop-of-horrors-review-at-crucible-theatre-sheffield', '2019-01-01T00:00+00:00')])), []);
  assert.deepEqual(Object.keys(matchShows([s], [E('little-shop-of-horrors-review-at-crucible-theatre-sheffield', '2025-03-05T00:00+00:00')])), ['lsh']);
});

test('a studio inside the parent venue matches by name part plus city (Ustinov Studio, Bath)', () => {
  const s = show('jeeves', 'Jeeves Takes Charge', 'Theatre Royal Bath, Bath', '2024-12-17');
  assert.ok(matchEntry(s, E('jeeves-takes-charge-review-at-ustinov-studio-bath-from-director', '2024-12-17T14:21+00:00')));
});

test('a one-word venue needs the city too (Octagon, Bolton vs Octagon, Yeovil), and a missing lastmod is not a match', () => {
  const s = show('hf', 'Hobsons Choice', 'Octagon Theatre, Bolton', '2025-02-01');
  assert.equal(matchEntry(s, E('hobsons-choice-review-at-octagon-yeovil', '2025-02-05T00:00+00:00')), null);
  assert.ok(matchEntry(s, E('hobsons-choice-review-at-octagon-theatre-bolton', '2025-02-05T00:00+00:00')));
  assert.deepEqual(Object.keys(matchShows([s], [E('hobsons-choice-review-at-octagon-theatre-bolton', undefined)])), []);
});
