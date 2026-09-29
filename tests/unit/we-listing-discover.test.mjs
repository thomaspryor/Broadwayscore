// BRO-3787: audit of the remaining short (<=8 char slug) WEST_END_VENUES
// entries for the same non-West-End name-collision class BRO-3716 found for
// "lyric" (Lyric Hammersmith). Tests the REAL exported matcher per CLAUDE.md
// §15 — no logic copies. Existing playhouse/cambridge/lyric collision tests
// live in promote-we-aggregator-auto.test.mjs; this file covers the new ones
// found by this audit.
//
// coliseum/queens are blanket-excluded (WE_SLUG_GENERIC_EXCLUDE) — evidence
// showed genuine West End slugs never rely on the bare form. apollo/garrick/
// lyceum/old vic/phoenix/savoy are each ALSO major, currently-active West
// End venues with real, already-observed bare-slug matches, so they get the
// narrower WE_SLUG_FALSE_POSITIVE_RE treatment instead (reject only the
// specific colliding compound) — an earlier draft blanket-excluded all 8 and
// an adversarial ship-check review caught that it silently broke live
// discovery for the genuine West End venue too, not just the collision.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { matchWestEndVenueFromSlug } = require('../../scripts/lib/we-listing-discover.js');

test('matchWestEndVenueFromSlug: o2-apollo-manchester is excluded (non-West-End)', () => {
  assert.equal(matchWestEndVenueFromSlug('review-a-gig-o2-apollo-manchester'), null);
});
test('matchWestEndVenueFromSlug: the real West End Apollo Theatre still matches', () => {
  const m = matchWestEndVenueFromSlug('christmas-carol-goes-wrong-apollo-theatre-review');
  assert.equal(m && m.venue, 'apollo');
});
test('matchWestEndVenueFromSlug: apollo victoria (the real West End venue) still matches', () => {
  const m = matchWestEndVenueFromSlug('a-play-apollo-victoria-review');
  assert.equal(m && m.venue, 'apollo victoria');
});

test('matchWestEndVenueFromSlug: coliseum is excluded (collides with the non-West-End Oldham Coliseum Theatre)', () => {
  assert.equal(matchWestEndVenueFromSlug('a-christmas-carol-oldham-coliseum-review'), null);
});
// The West End's own London Coliseum stays matchable via its separate,
// longer "london coliseum" WEST_END_VENUES entry, unaffected by the above.
test('matchWestEndVenueFromSlug: london coliseum (the real West End venue) still matches', () => {
  const m = matchWestEndVenueFromSlug('giselle-london-coliseum-review');
  assert.equal(m && m.venue, 'london coliseum');
});

test('matchWestEndVenueFromSlug: lichfield-garrick is excluded (non-West-End)', () => {
  assert.equal(matchWestEndVenueFromSlug('a-play-lichfield-garrick-review'), null);
});
test('matchWestEndVenueFromSlug: the real West End Garrick Theatre still matches', () => {
  const m = matchWestEndVenueFromSlug('why-i-stuck-a-flare-up-my-arse-for-england-garrick-theatre-review');
  assert.equal(m && m.venue, 'garrick');
});

test('matchWestEndVenueFromSlug: royal-lyceum-edinburgh is excluded (non-West-End)', () => {
  assert.equal(matchWestEndVenueFromSlug('a-play-royal-lyceum-edinburgh-review'), null);
});
test('matchWestEndVenueFromSlug: the real West End Lyceum still matches', () => {
  const m = matchWestEndVenueFromSlug('the-lion-king-lyceum-theatre-review');
  assert.equal(m && m.venue, 'lyceum');
});

test('matchWestEndVenueFromSlug: bristol-old-vic is excluded (non-West-End)', () => {
  assert.equal(matchWestEndVenueFromSlug('a-play-bristol-old-vic-review'), null);
});
// Genuine West End Old Vic slugs observed in this repo's audit data use bare
// "old-vic" with no "the-" prefix — a blanket Set exclusion (first attempt)
// would have broken this; the scoped regex above preserves it.
test('matchWestEndVenueFromSlug: the real West End Old Vic (bare "old-vic", no "the-") still matches', () => {
  const m = matchWestEndVenueFromSlug('arcadia-old-vic-review');
  assert.equal(m && m.venue, 'old vic');
});
test('matchWestEndVenueFromSlug: the-old-vic (the real West End venue, longer form) still matches', () => {
  const m = matchWestEndVenueFromSlug('how-the-other-half-loves-the-old-vic');
  assert.equal(m && m.venue, 'the old vic');
});

test('matchWestEndVenueFromSlug: exeter-phoenix is excluded (non-West-End)', () => {
  assert.equal(matchWestEndVenueFromSlug('a-play-exeter-phoenix-review'), null);
});
test('matchWestEndVenueFromSlug: the real West End Phoenix Theatre still matches', () => {
  const m = matchWestEndVenueFromSlug('a-play-phoenix-theatre-review');
  assert.equal(m && m.venue, 'phoenix');
});

test("matchWestEndVenueFromSlug: queen's is excluded (collides with the non-West-End Queen's Theatre, Hornchurch)", () => {
  assert.equal(matchWestEndVenueFromSlug('a-play-queens-theatre-hornchurch-review'), null);
});

test('matchWestEndVenueFromSlug: savoy-theatre-monmouth is excluded (non-West-End)', () => {
  assert.equal(matchWestEndVenueFromSlug('a-play-savoy-theatre-monmouth-review'), null);
});
test('matchWestEndVenueFromSlug: the real West End Savoy Theatre still matches', () => {
  const m = matchWestEndVenueFromSlug('review-roundup-paddington-the-musical-savoy-theatre');
  assert.equal(m && m.venue, 'savoy');
});
