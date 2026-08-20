// TESTS-VS-DERIVED-DATA-EXEMPT: structural check only (no title collides with
// another show's title in shows.json) — never pins facts about specific shows.
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MEZZANINE_OVERRIDES, normalize } = require('../../scripts/scrape-mezzanine-audience.js');
const { shows } = require('../../data/shows.json');

// BRO-86: card #313 fixed 2 title-drift Mezzanine coverage gaps
// (romeo-juliet-2024, hot-mess-a-new-musical-off-west-end-2026). Auditing
// that fix (/what-else lens 1) found the same bug class already live for 4
// more MEZZANINE_OVERRIDES entries with common/frequently-revived titles
// (Cabaret, Little Women, The Little Mermaid, The Fever) — fixed in
// f9e1c76736c. This auditor generalizes the check so a NEW override never
// silently reintroduces the bug: a bare-string override matches ANY
// Mezzanine production with that name (see Strategy 0 in matchProductions,
// scripts/scrape-mezzanine-audience.js) with no venue or year gate, unlike
// the sibling-aware exact-title match (Strategy 1). If the override's name
// collides with another show's own title in shows.json, that other show's
// real Mezzanine production gets merged in — the venue-pinned {name, venue}
// object form is required for any such override.
//
// This check is bounded by our own catalog: it catches collisions with
// OTHER shows we track (which is how Little Women/Little Mermaid/Romeo &
// Juliet/Harry Potter/Six/Heathers were all found), not collisions with
// stray Mezzanine productions outside shows.json (Cabaret/The Fever — those
// were found by manual /what-else audit and are covered by dedicated
// regression tests, not this one).

function buildTitleIndex(showList) {
  const byNorm = new Map();
  for (const s of showList) {
    const norm = normalize(s.title);
    if (!byNorm.has(norm)) byNorm.set(norm, []);
    byNorm.get(norm).push(s.id);
  }
  return byNorm;
}

function findCommonTitleCollisions(overrides, showList) {
  const byNorm = buildTitleIndex(showList);
  const collisions = [];
  for (const [showId, override] of Object.entries(overrides)) {
    const isBare = typeof override === 'string';
    if (!isBare) continue; // venue/other-pinned object form is already safe
    const normOverride = normalize(override);
    const siblingIds = (byNorm.get(normOverride) || []).filter(id => id !== showId);
    if (siblingIds.length > 0) {
      collisions.push({ showId, overrideName: override, collidesWith: siblingIds });
    }
  }
  return collisions;
}

describe('Mezzanine override collision auditor', () => {
  test('no bare-string override collides with another tracked show\'s own title', () => {
    const collisions = findCommonTitleCollisions(MEZZANINE_OVERRIDES, shows);
    assert.deepStrictEqual(
      collisions,
      [],
      `Found ${collisions.length} un-pinned common-title collision(s): ${JSON.stringify(collisions, null, 2)}\n` +
        'Fix: convert the bare-string override to { name, venue } in MEZZANINE_OVERRIDES ' +
        '(scripts/scrape-mezzanine-audience.js), pinning to the venue of the correct production.'
    );
  });

  test('every MEZZANINE_OVERRIDES key exists in shows.json (no dead config)', () => {
    const showIds = new Set(shows.map(s => s.id));
    const deadKeys = Object.keys(MEZZANINE_OVERRIDES).filter(id => !showIds.has(id));
    assert.deepStrictEqual(deadKeys, [], `Dead MEZZANINE_OVERRIDES keys (no matching show): ${deadKeys.join(', ')}`);
  });

  test('every venue-pinned override has a non-empty venue string', () => {
    const badPins = Object.entries(MEZZANINE_OVERRIDES)
      .filter(([, override]) => typeof override === 'object' && override !== null)
      .filter(([, override]) => typeof override.venue !== 'string' || override.venue.trim().length === 0)
      .map(([showId]) => showId);
    assert.deepStrictEqual(badPins, [], `Overrides with empty/missing venue pin: ${badPins.join(', ')}`);
  });

  // Regression fixtures for the collision class this auditor generalizes.
  // Reproduces the bug directly: a synthetic sibling show sharing an
  // override's normalized title must be caught by findCommonTitleCollisions.
  test('detects a synthetic bare-string collision against a same-titled sibling', () => {
    const syntheticOverrides = { 'show-a': 'Common Title' };
    const syntheticShows = [
      { id: 'show-a', title: 'Common Title (Our Production)' },
      { id: 'show-b', title: 'Common Title' },
    ];
    const collisions = findCommonTitleCollisions(syntheticOverrides, syntheticShows);
    assert.strictEqual(collisions.length, 1);
    assert.strictEqual(collisions[0].showId, 'show-a');
    assert.deepStrictEqual(collisions[0].collidesWith, ['show-b']);
  });

  test('venue-pinned object-form overrides are never flagged even if they collide', () => {
    const syntheticOverrides = { 'show-a': { name: 'Common Title', venue: 'Some Venue' } };
    const syntheticShows = [
      { id: 'show-a', title: 'Common Title (Our Production)' },
      { id: 'show-b', title: 'Common Title' },
    ];
    const collisions = findCommonTitleCollisions(syntheticOverrides, syntheticShows);
    assert.deepStrictEqual(collisions, []);
  });

  test('all four originally-flagged card #313 titles (Cabaret, Little Women, Little Mermaid, The Fever) are venue-pinned', () => {
    const originallyFlagged = [
      'cabaret-at-the-kit-kat-club-west-end-2021',
      'little-women-the-musical-off-broadway-2026',
      'the-little-mermaid-the-musical-off-broadway-2026',
      'the-fever-greenwich-house-theater-off-broadway-2026',
    ];
    for (const showId of originallyFlagged) {
      const override = MEZZANINE_OVERRIDES[showId];
      assert.ok(override, `expected an override for ${showId}`);
      assert.strictEqual(typeof override, 'object', `expected ${showId} override to be venue-pinned object form, got bare string`);
    }
  });
});
