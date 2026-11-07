// BRO-7086: undated rows whose URL names a venue the show never played.
// Requires the real detector (CLAUDE.md s15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { detectUndatedVenueUrl, buildVenueIndex } = require('./undated-venue-url.js');

const shows = [
  { id: 'phantom', title: 'The Phantom of the Opera', venue: "His Majesty's Theatre" },
  { id: 'wawm', title: 'When We Are Married', venue: 'Garrick Theatre' },
  { id: 'donmar-show', title: 'Something Else', venue: 'Donmar Warehouse' },
  { id: 'natl', title: 'The Authenticator', venue: 'National Theatre (Dorfman)' },
  { id: 'skylight', title: 'Skylight', venue: "Wyndham's Theatre" },
  { id: 'tour', title: 'Life of Pi', venue: 'North American Tour', category: 'tour' },
  { id: 'prior', title: 'Next to Normal', venue: "Wyndham's Theatre", priorRuns: [{ venue: 'Donmar Warehouse' }] },
  { id: 'friedman', title: 'Lackawanna Blues', venue: 'Samuel J. Friedman Theatre' },
];
const idx = buildVenueIndex(shows, ['Donmar Warehouse', 'Skylight Theatre', 'Dorfman Theatre', 'Noël Coward Theatre', 'Ahmanson Theatre']);
const by = id => shows.find(s => s.id === id);
const hit = (id, url, extra = {}) => detectUndatedVenueUrl({ url, ...extra }, by(id), idx);

test('BRO-7086 case: Phantom row whose URL names the Donmar', () => {
  const d = hit('phantom', 'https://www.telegraph.co.uk/theatre/what-to-see/when-we-are-married-donmar-warehouse-review/');
  assert.ok(d); assert.match(d.venues.join(), /Donmar/);
});
test('2010 Garrick run with a Donmar URL', () => {
  assert.ok(hit('wawm', 'https://theartsdesk.com/theatre/when-we-are-married-donmar-warehouse-review'));
});
test('dated rows are not this check\'s job', () => {
  assert.equal(hit('wawm', 'https://x.com/when-we-are-married-donmar-warehouse-review', { publishDate: '2010-01-01' }), null);
});
test("the show's own venue in the URL clears it", () => {
  assert.equal(hit('donmar-show', 'https://x.com/something-else-donmar-warehouse-review'), null);
});
test('declared prior run venue is not foreign', () => {
  assert.equal(hit('prior', 'https://www.londontheatre.co.uk/reviews/next-to-normal-review-donmar-warehouse'), null);
});
test('same building under another stage name is not foreign', () => {
  assert.equal(hit('natl', 'https://x.com/review-the-authenticator-dorfman-theatre'), null);
});
test('venue word that is the show title is not a venue mention', () => {
  assert.equal(hit('skylight', 'https://letterboxd.com/loureviews/film/national-theatre-live-skylight/'), null);
});
test('person-named theatre needs "theatre" after the name', () => {
  assert.equal(hit('wawm', 'https://x.com/a-hilarious-noel-coward-on-broadway-in-fallen-angels-review'), null);
  assert.ok(hit('wawm', 'https://x.com/review-at-the-noel-coward-theatre'));
});
test('tours play many houses by design', () => {
  assert.equal(hit('tour', 'https://x.com/life-of-pi-roars-to-life-at-the-ahmanson-theatre'), null);
});
test('MTC producer slug matches its Friedman house', () => {
  assert.equal(hit('friedman', 'https://x.com/lackawanna-blues-manhattan-theatre-club-review'), null);
});
test('no venue in URL, no hit', () => {
  assert.equal(hit('phantom', 'https://x.com/the-phantom-of-the-opera-review'), null);
});
