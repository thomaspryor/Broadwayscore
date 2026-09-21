// BRO-3787: audit of the remaining short (<=8 char slug) WEST_END_VENUES
// entries for the same non-West-End name-collision class BRO-3716 found for
// "lyric" (Lyric Hammersmith). Tests the REAL exported matcher per CLAUDE.md
// §15 — no logic copies. Existing playhouse/cambridge/lyric collision tests
// live in promote-we-aggregator-auto.test.mjs; this file covers the new ones
// found by this audit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { matchWestEndVenueFromSlug } = require('../../scripts/lib/we-listing-discover.js');

test('matchWestEndVenueFromSlug: apollo is excluded (collides with the non-West-End O2 Apollo Manchester)', () => {
  assert.equal(matchWestEndVenueFromSlug('review-a-gig-o2-apollo-manchester'), null);
});

test('matchWestEndVenueFromSlug: coliseum is excluded (collides with the non-West-End Oldham Coliseum Theatre)', () => {
  assert.equal(matchWestEndVenueFromSlug('a-christmas-carol-oldham-coliseum-review'), null);
});
// The West End's own London Coliseum stays matchable via its separate,
// longer "london coliseum" WEST_END_VENUES entry, unaffected by the above.
test('matchWestEndVenueFromSlug: london coliseum (the real West End venue) still matches', () => {
  const m = matchWestEndVenueFromSlug('a-play-london-coliseum-review');
  assert.equal(m && m.venue, 'london coliseum');
});

test('matchWestEndVenueFromSlug: garrick is excluded (collides with the non-West-End Lichfield Garrick Theatre)', () => {
  assert.equal(matchWestEndVenueFromSlug('a-play-lichfield-garrick-review'), null);
});

test('matchWestEndVenueFromSlug: lyceum is excluded (collides with the non-West-End Royal Lyceum Theatre, Edinburgh)', () => {
  assert.equal(matchWestEndVenueFromSlug('a-play-royal-lyceum-edinburgh-review'), null);
});

test('matchWestEndVenueFromSlug: old vic is excluded (collides with the non-West-End Bristol Old Vic)', () => {
  assert.equal(matchWestEndVenueFromSlug('a-play-bristol-old-vic-review'), null);
});
// The more specific "the-old-vic" WEST_END_VENUES entry (for the real West
// End Old Vic) is NOT excluded and still matches.
test('matchWestEndVenueFromSlug: the-old-vic (the real West End venue) still matches', () => {
  const m = matchWestEndVenueFromSlug('how-the-other-half-loves-the-old-vic');
  assert.equal(m && m.venue, 'the old vic');
});

test('matchWestEndVenueFromSlug: phoenix is excluded (collides with the non-West-End Exeter Phoenix)', () => {
  assert.equal(matchWestEndVenueFromSlug('a-play-exeter-phoenix-review'), null);
});

test("matchWestEndVenueFromSlug: queen's is excluded (collides with the non-West-End Queen's Theatre, Hornchurch)", () => {
  assert.equal(matchWestEndVenueFromSlug('a-play-queens-theatre-hornchurch-review'), null);
});

test('matchWestEndVenueFromSlug: savoy is excluded (collides with the non-West-End Savoy Theatre, Monmouth)', () => {
  assert.equal(matchWestEndVenueFromSlug('a-play-savoy-theatre-monmouth-review'), null);
});

test('matchWestEndVenueFromSlug: apollo victoria (the real West End venue) still matches', () => {
  const m = matchWestEndVenueFromSlug('a-play-apollo-victoria-review');
  assert.equal(m && m.venue, 'apollo victoria');
});
