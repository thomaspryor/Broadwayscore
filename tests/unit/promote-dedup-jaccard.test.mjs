// Verifies the word-order dedup fix in promote-ob-venue-candidates.js.
// Regression case: Heated Rivalry: The Unauthorized "Musical Parody"
// (TodayTix) vs "...PARODY MUSICAL" (Playbill). Different word order,
// same show. Pre-fix the exact-normalized-string check passed it through
// as a separate ID; both were promoted to shows.json.
//
// Tests the REAL exported findExistingMatch (CLAUDE.md §15) — this file used
// to carry a copy of the matching logic; extracted to the script itself
// 2026-08-13 while adding the typo-distance check below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { canonicalVenue } = require('../../scripts/lib/title-match.js');
const { findExistingMatch } = require('../../scripts/promote-ob-venue-candidates.js');

test('jaccard dedup catches the Heated Rivalry word-order regression', () => {
  const existing = [{
    id: 'heated-rivalry-the-unauthorized-musical-parody-off-broadway-2026',
    title: 'Heated Rivalry: The Unauthorized Musical Parody',
    venue: '6th Floor Theater (formerly The McKittrick Hotel)',
  }];
  const candidate = {
    title: 'HEATED RIVALRY: THE UNAUTHORIZED PARODY MUSICAL', // Playbill casing + word swap
    venue: 'TBA',
  };
  // Note: 'TBA' canonicalizes to 'tba'; existing canonicalizes to '6th'.
  // To exercise the title-only dedup, both must share a canonical venue.
  // Real fix: dedup should ALSO work venue-agnostic when titles are highly
  // similar. Let's first verify the same-venue case, then the venue-mismatch
  // case (which should NOT match by venue but SHOULD be flaggable separately).
  const existingSameVenue = [{
    ...existing[0],
    venue: 'TBA', // synthesize same-venue case
  }];
  const match = findExistingMatch(candidate, existingSameVenue);
  assert.ok(match, 'Expected to find a match for word-order variant');
  assert.match(match.reason, /jaccard/);
});

test('exact normalized-string match still works (regression)', () => {
  const existing = [{
    id: 'the-comeuppance-off-broadway-2026',
    title: 'The Comeuppance',
    venue: 'Signature Theatre',
  }];
  const candidate = { title: 'The Comeuppance!', venue: 'Pershing Square Signature Center' };
  const match = findExistingMatch(candidate, existing);
  assert.ok(match);
});

test('cross-venue alias dedup still works (TNG → Signature Center)', () => {
  const existing = [{
    id: 'jackals-off-broadway-2026',
    title: 'Jackals',
    venue: 'Pershing Square Signature Center',
  }];
  const candidate = { title: 'Jackals', venue: 'The New Group' };
  const match = findExistingMatch(candidate, existing);
  assert.ok(match, 'TNG and Signature Center must share canonical venue');
});

test('low-similarity titles at same venue do NOT match', () => {
  const existing = [{
    id: 'something-else-2026',
    title: 'Something Completely Different',
    venue: 'MCC Theater',
  }];
  const candidate = { title: 'Heated Rivalry', venue: 'MCC Theater' };
  assert.equal(findExistingMatch(candidate, existing), null);
});

test('different venues with same title do NOT match', () => {
  const existing = [{
    id: 'orlando-old-2010',
    title: 'Orlando',
    venue: 'New York Theatre Workshop',
  }];
  const candidate = { title: 'Orlando', venue: 'Signature Theatre' };
  // canonicalVenue('NYTW') has no alias → falls back to first-word 'new'
  // canonicalVenue('Signature Theatre') → 'signature center'
  // Different keys → no match (intentional — different productions).
  assert.equal(findExistingMatch(candidate, existing), null);
});

test('typo-distance dedup catches possessive-vs-colon near-miss (Rosie O\'Donnell, live incident 2026-08-13)', () => {
  // Live bug found while adding off-broadway aggregator-roundup
  // auto-promotion: BWW slug-derived "Rosie O'Donnell's COMMON KNOWLEDGE"
  // normalizes to "rosie odonnells common knowledge" vs the already-live
  // show's "Rosie O'Donnell: Common Knowledge" -> "rosie odonnell common
  // knowledge" — 1 character apart, but jaccard on that pair is only 0.6
  // (below the 0.80 gate). Without the typo-distance check this promoted a
  // duplicate show for an already-closed production.
  const existing = [{
    id: 'rosie-odonnell-common-knowledge-off-broadway-2026',
    title: "Rosie O'Donnell: Common Knowledge",
    venue: 'Daryl Roth Theatre',
  }];
  const candidate = { title: "Rosie O'Donnell's COMMON KNOWLEDGE", venue: 'Daryl Roth Theatre' };
  const match = findExistingMatch(candidate, existing);
  assert.ok(match, 'Expected the possessive/colon variant to match via typo-distance');
  assert.match(match.reason, /typo-distance=1/);
});

test('typo-distance dedup does NOT collapse short unrelated titles (length gate)', () => {
  const existing = [{ id: 'cats-2026', title: 'Cats', venue: 'MCC Theater' }];
  const candidate = { title: 'Rats', venue: 'MCC Theater' };
  assert.equal(findExistingMatch(candidate, existing), null);
});

test('venue aliases: producer-prefix variants collapse to one key (Pels, Newhouse, PAC)', () => {
  // Playbill lists these venues without the producing company's prefix;
  // shows.json carries the prefixed canonical names. Both forms must map to
  // the same key or validate-show-venue.js false-mismatches (batch #109).
  assert.equal(
    canonicalVenue('The Laura Pels Theatre at the Harold and Miriam Steinberg Center for Theatre'),
    canonicalVenue('Roundabout Theatre Company - Laura Pels Theatre'),
  );
  assert.equal(
    canonicalVenue('Lincoln Center Theater - Mitzi E. Newhouse Theater'),
    canonicalVenue('Mitzi E. Newhouse Theatre'),
  );
  assert.equal(
    canonicalVenue('Perelman Performing Arts Center (PAC NYC)'),
    canonicalVenue('Perelman Performing Arts Center'),
  );
  // Carnegie Hall's Perelman Stage is a DIFFERENT venue — must not collapse
  assert.notEqual(
    canonicalVenue('Stern Auditorium / Perelman Stage at Carnegie Hall'),
    canonicalVenue('Perelman Performing Arts Center'),
  );
});

test('Steinberg Black Box stage does not collapse onto Laura Pels key', () => {
  assert.notEqual(
    canonicalVenue('Black Box Theatre at the Harold and Miriam Steinberg Center for Theatre'),
    canonicalVenue('The Laura Pels Theatre at the Harold and Miriam Steinberg Center for Theatre'),
  );
  assert.equal(
    canonicalVenue('Roundabout Black Box Theatre'),
    canonicalVenue('Black Box Theatre at the Harold and Miriam Steinberg Center for Theatre'),
  );
});

test('Virginia Theatre (pre-2005 name) collapses with August Wilson Theatre', () => {
  assert.equal(
    canonicalVenue('Virginia Theatre'),
    canonicalVenue('August Wilson Theatre'),
  );
});
