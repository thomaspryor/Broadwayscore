// Launch-critical: the two London hubs must route every show correctly.
// getWestEndShows() / getOffWestEndShows() in data-core map these pure predicates
// over the catalog; testing the predicates locks the routing decision without
// loading the full data pipeline. (Extracted from data-core for exactly this.)
//
// The non-theatrical exclusion is the bug this guards: dance/magic/comedy shows
// were appearing on the West End plays/musicals listing with a category-error
// critic score. The invariants below must hold for every London show.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  belongsOnWestEndListing,
  belongsOnOffWestEndHub,
  NON_THEATRICAL_GENRES,
} from '../../src/lib/genre';

// --- Per-case routing -------------------------------------------------------

test('West End theatrical show: on the West End listing, not the OWE hub', () => {
  const s = { category: 'west-end', genre: undefined };
  assert.equal(belongsOnWestEndListing(s), true);
  assert.equal(belongsOnOffWestEndHub(s), false);
});

test('Off-West End theatrical show: on BOTH hubs (by design — /west-end toggle)', () => {
  const s = { category: 'off-west-end', genre: undefined };
  assert.equal(belongsOnWestEndListing(s), true);
  assert.equal(belongsOnOffWestEndHub(s), true);
});

test('Non-theatrical show at a West-End-category venue: OWE hub only, never the WE listing', () => {
  // This is the launch bug: dance at Sadler's Wells (a West End venue) must NOT
  // show on the West End listing even though its category is west-end.
  const s = { category: 'west-end', genre: 'dance' };
  assert.equal(belongsOnWestEndListing(s), false);
  assert.equal(belongsOnOffWestEndHub(s), true);
});

test('Non-theatrical show with off-west-end category: OWE hub only', () => {
  const s = { category: 'off-west-end', genre: 'magic' };
  assert.equal(belongsOnWestEndListing(s), false);
  assert.equal(belongsOnOffWestEndHub(s), true);
});

test('Non-London category (broadway): on neither London hub', () => {
  for (const category of ['broadway', 'off-broadway', 'regional', undefined]) {
    const s = { category, genre: undefined };
    assert.equal(belongsOnWestEndListing(s), false, `WE for ${category}`);
    assert.equal(belongsOnOffWestEndHub(s), false, `OWE for ${category}`);
  }
});

// --- Invariants over the full {category × genre} space ----------------------

test('INVARIANT: no non-theatrical show is ever on the West End listing', () => {
  for (const genre of NON_THEATRICAL_GENRES) {
    for (const category of ['west-end', 'off-west-end']) {
      assert.equal(
        belongsOnWestEndListing({ category, genre }),
        false,
        `${genre} @ ${category} leaked onto the West End listing`,
      );
    }
  }
});

test('INVARIANT: every non-theatrical London show is on the Off-West End hub', () => {
  for (const genre of NON_THEATRICAL_GENRES) {
    for (const category of ['west-end', 'off-west-end']) {
      assert.equal(
        belongsOnOffWestEndHub({ category, genre }),
        true,
        `${genre} @ ${category} missing from the Off-West End hub`,
      );
    }
  }
});

test('INVARIANT: every London-category show lands on at least one hub (no orphans)', () => {
  const genres = [undefined, 'play', 'musical', ...NON_THEATRICAL_GENRES];
  for (const category of ['west-end', 'off-west-end']) {
    for (const genre of genres) {
      const s = { category, genre: genre as string | undefined };
      assert.ok(
        belongsOnWestEndListing(s) || belongsOnOffWestEndHub(s),
        `${genre ?? 'no-genre'} @ ${category} is orphaned (on neither hub)`,
      );
    }
  }
});

test('INVARIANT: an unknown genre is treated as theatrical (not auto-hidden)', () => {
  // A genre not in NON_THEATRICAL_GENRES (e.g. opera handled elsewhere, or a typo)
  // must NOT be excluded from the West End listing — only the explicit list hides.
  const s = { category: 'west-end', genre: 'opera' };
  assert.equal(belongsOnWestEndListing(s), true);
});
