// BRO-5358: a one-word title under 5 letters whose show has no cast or creative
// data (Soon, Rope, Baby, MYTH) could never be matched by the outlet-first poller.
// Its own venue, as a whole phrase, is the credit context. require()s the real
// matcher (CLAUDE.md §15). Venue and title strings copied from shows.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const helpers = require('./outlet-listing-helpers.js');
const NOW = Date.parse('2026-10-14T12:00:00Z');
const find = (h, u, shows, desc = '', publishDate = null) => helpers.findMatchingShows(h, u, shows, desc, { nowMs: NOW, publishDate });
const ids = (m) => m.map((s) => s.id);

const soon = { id: 'soon-off-broadway-2026', title: 'Soon', venue: "St. Luke's Theatre", status: 'open', cast: [], creativeTeam: [] };
const rope = { id: 'rope-off-broadway-2026', title: 'Rope', venue: "Theatre at St. Clement's", status: 'previews', cast: [], creativeTeam: [] };
const baby = { id: 'baby-off-west-end-2026', title: 'Baby', venue: 'Brixton House', status: 'previews', cast: [], creativeTeam: [] };
const myth = { id: 'myth-off-broadway-2026', title: 'MYTH', venue: 'JACK', status: 'open', cast: [], creativeTeam: [] };
const soonDated = { ...soon, previewsStartDate: '2026-09-30', openingDate: '2026-10-05' };
const all = [soon, rope, baby, myth];

test('each credit-less short-title show matches with its own venue', () => {
  assert.deepEqual(ids(find("Review: Soon at St. Luke's Theatre", 'review-soon-st-lukes-theatre', all)), [soon.id]);
  assert.deepEqual(ids(find("Rope review: tense at Theatre at St. Clement's", 'rope-review-theatre-at-st-clements', all)), [rope.id]);
  assert.deepEqual(ids(find('Baby review: Brixton House', 'baby-review', all)), [baby.id]);
  assert.deepEqual(ids(find('MYTH review: a night at JACK', 'myth-review-jack', all)), [myth.id]);
});

test('the venue may sit in the slug or the feed description instead of the headline', () => {
  assert.deepEqual(ids(find('Soon review', '/2026/10/soon-review-st-lukes-theatre', all)), [soon.id]);
  assert.deepEqual(ids(find('Baby review', '/baby-review', all, 'A new musical now playing at Brixton House.')), [baby.id]);
});

test('a generic headline with the word but not the venue does not match', () => {
  assert.equal(find('Soon: what to expect from the autumn season', 'soon-autumn-season', all).length, 0);
  assert.equal(find('Baby on board: parenting at the theatre', 'baby-on-board', all).length, 0);
  assert.equal(find('Rope trick review', 'rope-trick-review', all).length, 0);
});

test('another show’s venue does not match', () => {
  assert.equal(find('Soon review at Brixton House', 'soon-brixton-house', all).length, 0);
  assert.equal(find("Baby at St. Luke's Theatre", 'baby-st-lukes', all).length, 0);
  assert.equal(find('Rope at JACK', 'rope-jack', all).length, 0);
});

test('the venue alone, without the title, matches nothing', () => {
  assert.equal(find("A night at St. Luke's Theatre", 'a-night-st-lukes-theatre', all).length, 0);
});

test('a one-word venue under 6 letters must appear as stored (JACK), not as the name Jack', () => {
  assert.equal(find('MYTH review: Jack Black cameo', 'myth-review-jack-black', all).length, 0);
  assert.equal(find('MYTH: jack of all trades', 'myth-jack-of-all-trades', all).length, 0);
  assert.equal(find('MYTH review: a night at JACK', 'myth-review', all).length, 1);
});

test('a show with usable credits keeps the credit rule and ignores the venue', () => {
  const withCredits = { ...soon, creativeTeam: [{ name: 'Jane Roe', role: 'Director' }] };
  assert.equal(find("Soon at St. Luke's Theatre", 'soon-st-lukes', [withCredits]).length, 0);
  assert.equal(find('Soon: Jane Roe directs', 'soon-jane-roe', [withCredits]).length, 1);
});

test('a generic venue is not a signal', () => {
  const tbd = { ...soon, venue: 'TBD' };
  const bare = { ...soon, venue: 'Theatre' };
  assert.equal(find('Soon at TBD', 'soon-tbd', [tbd]).length, 0);
  assert.equal(find('Soon at the theatre', 'soon-theatre', [bare]).length, 0);
});

test('a longer-titled show at the same venue owns an article that names both', () => {
  const other = { id: 'hamlet-off-broadway-2026', title: 'Hamlet', venue: "St. Luke's Theatre", status: 'open', cast: [], creativeTeam: [] };
  assert.deepEqual(ids(find("Hamlet at St. Luke's Theatre: closing soon", 'hamlet-st-lukes-closing-soon', [soon, other])), [other.id]);
});

test('namesShowVenue is exported and false for a show with no venue', () => {
  assert.equal(helpers.namesShowVenue('soon', 'Soon', { ...soon, venue: '' }, NOW), false);
});

// Real feed items (BRO-5358): Off Off Online and Theater Scene headline their Soon
// reviews with the bare title and name no venue, cast or writer.
test('a headline that is exactly the title, published inside the run window, matches', () => {
  assert.deepEqual(ids(find('Soon', '/offoffonline/2026/9/29/soon', [soonDated], '', '2026-09-29')), [soon.id]);
  assert.deepEqual(ids(find('Review: Soon', '/review-soon', [soonDated], '', '2026-10-06')), [soon.id]);
  assert.deepEqual(ids(find('Soon review', '/soon-review', [soonDated], '', '2026-10-20')), [soon.id]);
});

test('the bare-title path needs the run window and an exact headline', () => {
  assert.equal(find('Soon', '/soon', [soonDated], '', '2026-03-01').length, 0);      // another production, months earlier
  assert.equal(find('Soon', '/soon', [soonDated], '', '2026-12-01').length, 0);      // long after the run window
  assert.equal(find('Soon', '/soon', [soonDated]).length, 0);                        // no publish date at all
  assert.equal(find('Soon to be a hit?', '/soon-to-be-a-hit', [soonDated], '', '2026-10-06').length, 0);
  assert.equal(find('How Soon is Now?', '/how-soon-is-now', [soonDated], '', '2026-10-06').length, 0);
  assert.equal(find('Soon', '/soon', [myth], '', '2026-10-06').length, 0);           // MYTH has no dates: no window
});

test('a common-word show with credits still never uses the bare-title path', () => {
  const six = { id: 'six-broadway', title: 'SIX', venue: 'Lena Horne Theatre', status: 'open', previewsStartDate: '2026-09-30', openingDate: '2026-10-05', cast: [{ name: 'Jane Roe', role: 'Anne' }], creativeTeam: [] };
  assert.equal(find('SIX', '/six', [six], '', '2026-10-06').length, 0);
});

test('venue credit needs the item to call itself a review (news about the venue is not filed)', () => {
  assert.equal(find("Soon to open at St. Luke's Theatre", 'soon-to-open-st-lukes-theatre', all).length, 0);
  assert.equal(find("Soon at St. Luke's Theatre: tickets on sale", 'soon-st-lukes-tickets', all).length, 0);
  assert.equal(find("Soon at St. Luke's Theatre", 'soon-st-lukes', all, 'Our review of the new musical.').length, 1);
});
