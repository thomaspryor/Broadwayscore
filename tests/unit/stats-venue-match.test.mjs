/**
 * venue-match — normalizeVenueKey extraction parity + diary→house matching.
 *
 * The parity block is the important half: normalizeVenueKey was lifted OUT of
 * venue-classification.ts, and that function decides West End vs Off-West End
 * market routing for every London show. Any behavior change there silently
 * re-routes markets, so the old inline implementation is reproduced here and
 * diffed against the extracted one over the real venue corpus.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  VENUE_ALIASES,
  buildHouseIndex,
  isBroadwayHouseCandidate,
  matchVenueToHouse,
  normalizeForMatch,
  normalizeVenueKey,
} from '../../src/lib/stats/venue-match';
import { isOffWestEndVenue } from '../../src/lib/venue-classification';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const META = JSON.parse(readFileSync(join(ROOT, 'data/theater-metadata.json'), 'utf8'));
const WEST_END = JSON.parse(readFileSync(join(ROOT, 'data/west-end-venues.json'), 'utf8'));
const SHOWS = (() => {
  const raw = JSON.parse(readFileSync(join(ROOT, 'data/shows.json'), 'utf8'));
  return Array.isArray(raw) ? raw : raw.shows;
})();

const HOUSE_NAMES = Object.keys(META).filter((k) => !k.startsWith('_'));
const FORMER_NAMES = {};
for (const n of HOUSE_NAMES) if (META[n]?.formerNames) FORMER_NAMES[n] = META[n].formerNames;
const INDEX = buildHouseIndex(HOUSE_NAMES, {}, FORMER_NAMES);

/** The implementation that lived inline in venue-classification.ts. */
function legacyNormalize(venue) {
  return venue
    .trim()
    .toLowerCase()
    .replace(/\s*\(.*\)$/, '')
    .replace(/ theatre$| theater$/, '');
}

test('PARITY: extracted normalizeVenueKey matches the old inline version on every real venue', () => {
  const corpus = new Set();
  for (const s of SHOWS) if (s.venue) corpus.add(s.venue);
  for (const v of WEST_END) corpus.add(v);
  for (const h of HOUSE_NAMES) corpus.add(h);
  assert.ok(corpus.size > 200, `corpus too small to be a real parity check: ${corpus.size}`);

  const diffs = [];
  for (const v of corpus) {
    if (legacyNormalize(v) !== normalizeVenueKey(v)) diffs.push(v);
  }
  assert.deepEqual(diffs, [], 'normalizeVenueKey drifted from the extracted original');
});

test('PARITY: isOffWestEndVenue is unchanged across every shows.json venue', () => {
  // Reimplements the pre-refactor predicate and diffs it against the live one.
  const westEndSet = new Set(WEST_END);
  const legacyIsOffWestEnd = (venue) => {
    if (!venue || venue === 'TBA') return false;
    return !westEndSet.has(legacyNormalize(venue));
  };
  const diffs = [];
  for (const s of SHOWS) {
    if (legacyIsOffWestEnd(s.venue) !== isOffWestEndVenue(s.venue)) diffs.push(s.venue);
  }
  assert.deepEqual(diffs, [], 'market routing changed');
  // Null/TBA contract preserved.
  assert.equal(isOffWestEndVenue(undefined), false);
  assert.equal(isOffWestEndVenue('TBA'), false);
});

test('normalizeVenueKey: frozen behavior — lowercase, trailing parenthetical, theatre/theater', () => {
  assert.equal(normalizeVenueKey('  Booth Theatre  '), 'booth');
  assert.equal(normalizeVenueKey('Booth Theater'), 'booth');
  // Parenthetical goes first, THEN the suffix strip sees the new tail.
  assert.equal(normalizeVenueKey('Sondheim Theatre (Queens)'), 'sondheim');
  assert.equal(normalizeVenueKey('Apollo Victoria (London)'), 'apollo victoria');
  assert.equal(normalizeVenueKey(null), '');
  assert.equal(normalizeVenueKey(''), '');
  // A mid-string "theatre" is NOT stripped — only a trailing one.
  assert.equal(normalizeVenueKey('Theatre Royal Drury Lane'), 'theatre royal drury lane');
});

test('normalizeForMatch folds curly apostrophes, periods, "the", and a trailing city', () => {
  assert.equal(normalizeForMatch('Audible’s Minetta Lane Theatre'), "audible's minetta lane");
  assert.equal(normalizeForMatch('St. James Theatre'), 'st james');
  assert.equal(normalizeForMatch('The Booth Theatre'), 'booth');
  assert.equal(normalizeForMatch('Marquis Theatre, New York'), 'marquis');
  assert.equal(normalizeForMatch('  Winter   Garden  Theatre '), 'winter garden');
});

test('every operating Broadway house resolves to itself', () => {
  const misses = HOUSE_NAMES.filter(
    (n) => matchVenueToHouse(n, INDEX, { category: 'broadway' }) !== n
  );
  assert.deepEqual(misses, [], 'a canonical house name failed to match itself');
  assert.equal(INDEX.houses.length, HOUSE_NAMES.length);
});

test('former names resolve to the current house (metadata + alias table)', () => {
  // From theater-metadata formerNames.
  assert.equal(
    matchVenueToHouse('Brooks Atkinson Theatre', INDEX, { category: 'broadway' }),
    'Lena Horne Theatre'
  );
  // From venue-aliases.json.
  assert.equal(
    matchVenueToHouse('Cort Theatre', INDEX, { category: 'broadway' }),
    'James Earl Jones Theatre'
  );
  assert.equal(
    matchVenueToHouse('American Airlines Theatre', INDEX, { category: 'broadway' }),
    'Todd Haimes Theatre'
  );
  assert.equal(
    matchVenueToHouse('Foxwoods Theatre', INDEX, { category: 'broadway' }),
    'Lyric Theatre'
  );
});

test('MARKET GATE: London venues never match a same-named Broadway house', () => {
  // The real collision from the owner's diary — Cursed Child at London's
  // Palace Theatre would otherwise log a Broadway house visit.
  assert.equal(matchVenueToHouse('Palace Theatre', INDEX, { category: 'west-end' }), null);
  assert.equal(matchVenueToHouse('Palace Theatre', INDEX, { category: 'off-west-end' }), null);
  assert.equal(
    matchVenueToHouse('Palace Theatre', INDEX, { category: 'broadway' }),
    'Palace Theatre'
  );
  // Same for the London Sondheim, which the alias table maps to Broadway's.
  assert.equal(matchVenueToHouse('Sondheim Theatre', INDEX, { category: 'west-end' }), null);
  assert.equal(
    matchVenueToHouse('Sondheim Theatre', INDEX, { category: 'broadway' }),
    'Stephen Sondheim Theatre'
  );
});

test('isBroadwayHouseCandidate blocks known non-Broadway markets, allows unknown', () => {
  for (const c of ['off-broadway', 'west-end', 'off-west-end', 'regional', 'us-regional']) {
    assert.equal(isBroadwayHouseCandidate(c), false, c);
  }
  assert.equal(isBroadwayHouseCandidate('broadway'), true);
  assert.equal(isBroadwayHouseCandidate(null), true);
  assert.equal(isBroadwayHouseCandidate(undefined), true);
});

test('UNMATCHED VENUES: Off-Broadway houses return null rather than a wrong house', () => {
  const offBroadway = [
    'Lucille Lortel Theatre',
    'New World Stages',
    'Playwrights Horizons',
    'Public Theater',
    'New York City Center',
    'Cherry Lane Theatre',
    'Masquerade NYC',
    '6th Floor Theater (formerly The McKittrick Hotel)',
  ];
  for (const v of offBroadway) {
    assert.equal(
      matchVenueToHouse(v, INDEX, { category: 'off-broadway' }),
      null,
      `${v} must not resolve to a Broadway house`
    );
  }
  // Empty / garbage input.
  assert.equal(matchVenueToHouse(null, INDEX, {}), null);
  assert.equal(matchVenueToHouse('', INDEX, {}), null);
  assert.equal(matchVenueToHouse('Nonexistent Playhouse', INDEX, { category: 'broadway' }), null);
});

test('alias table is well formed: every target is a real operating house', () => {
  const houses = new Set(HOUSE_NAMES);
  const bad = Object.entries(VENUE_ALIASES)
    .filter(([alias]) => !alias.startsWith('_'))
    .filter(([, target]) => !houses.has(target))
    .map(([alias, target]) => `${alias} -> ${target}`);
  assert.deepEqual(bad, [], 'alias points at a house that is not in theater-metadata.json');
  assert.ok(Object.keys(VENUE_ALIASES).length > 20);
});

test('alias table never shadows a canonical house name', () => {
  // An alias whose key normalizes onto a real house would silently redirect
  // that house's own visits somewhere else.
  const canonical = new Map(HOUSE_NAMES.map((n) => [normalizeForMatch(n), n]));
  const shadows = Object.entries(VENUE_ALIASES)
    .filter(([alias]) => !alias.startsWith('_'))
    .filter(([alias, target]) => {
      const owner = canonical.get(normalizeForMatch(alias));
      return owner && owner !== target;
    })
    .map(([alias, target]) => `${alias} -> ${target}`);
  assert.deepEqual(shadows, [], 'alias shadows a canonical house name');
});

test('caller-supplied aliases extend the index', () => {
  const custom = buildHouseIndex(HOUSE_NAMES, { 'My Local Barn': 'Booth Theatre' }, FORMER_NAMES);
  assert.equal(matchVenueToHouse('My Local Barn', custom, { category: 'broadway' }), 'Booth Theatre');
  // And are ignored when the target is not an operating house.
  const bogus = buildHouseIndex(HOUSE_NAMES, { 'My Local Barn': 'No Such Theatre' }, FORMER_NAMES);
  assert.equal(matchVenueToHouse('My Local Barn', bogus, { category: 'broadway' }), null);
});
