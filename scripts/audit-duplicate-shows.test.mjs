// BRO-4503: audit-duplicate-shows.js missed the Jena Friedman: Motherfucker pair
// because the title-fragment pass demanded byte-identical venues
// ("SoHo Playhouse" vs "Soho Playhouse Main Stage"). Requires the real detector.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findTitleFragmentDupes, sameVenueOrRoom, canonicalVenue } = require('./lib/show-duplicate-detection.js');

const jena = { id: 'jena-friedman-motherfucker-off-broadway-2026', title: 'Jena Friedman: Motherfucker', venue: 'SoHo Playhouse', openingDate: '2026-10-01', closingDate: '2026-10-11' };
const bare = { id: 'motherfucker-off-broadway-2026', title: 'Motherfucker', venue: 'Soho Playhouse Main Stage', openingDate: '2026-10-01', closingDate: null };

test('flags the Jena Friedman / Motherfucker pair (venue + room suffix, colon-segment title)', () => {
  const d = findTitleFragmentDupes([jena, bare]);
  assert.equal(d.length, 1);
  assert.deepEqual([d[0].a, d[0].b].sort(), [bare.id, jena.id].sort());
});

test('sameVenueOrRoom: room suffix matches, different houses and TBA do not', () => {
  const v = (s) => canonicalVenue({ venue: s });
  assert.ok(sameVenueOrRoom(v('SoHo Playhouse'), v('Soho Playhouse Main Stage')));
  assert.ok(sameVenueOrRoom(v('New World Stages'), v('New World Stages - Stage 5')));
  assert.ok(!sameVenueOrRoom(v('Lyric Theatre'), v('Lyric Hammersmith')));
  assert.ok(!sameVenueOrRoom(v('Park'), v('Park Avenue Armory')));
  assert.ok(sameVenueOrRoom(v('59E59 Theaters'), v('59E59 Theaters, Theater B')));
  assert.ok(!sameVenueOrRoom(v('New World Stages - Stage 1'), v('New World Stages - Stage 5')));
  assert.ok(!sameVenueOrRoom(v('59E59 Theaters - Theater A'), v('59E59 Theaters - Theater C')));
  assert.ok(!sameVenueOrRoom('tba', 'tba'));
  assert.ok(!sameVenueOrRoom('', 'soho playhouse'));
});

test('does NOT flag a same-title fragment at a different house or a later run', () => {
  assert.equal(findTitleFragmentDupes([jena, { ...bare, venue: 'Public Theater' }]).length, 0);
  assert.equal(findTitleFragmentDupes([jena, { ...bare, openingDate: '2026-12-01', closingDate: '2026-12-20' }]).length, 0);
});
