/**
 * Tests for scripts/lib/award-category-canonical.js + a data gate over
 * data/awards.json. Guards the forum-reported bug (2026-05-24): the same award
 * scraped under two name variants within one ceremony — e.g. Drama Desk /
 * Outer Critics Circle listing BOTH "Outstanding Direction of a Musical" AND
 * "Outstanding Director of a Musical", inflating win/nom counts and showing the
 * award twice on the show page.
 *
 * Run: node --test tests/unit/award-category-canonical.test.mjs
 */

// TESTS-VS-DERIVED-DATA-EXEMPT: the data gate reads data/awards.json to assert a
// STRUCTURAL invariant (zero synonym-duplicate categories, computed by the
// canonical lib itself) — not a rot-prone factual pin like "X won category Y".
// It must read the shipped derived file because gating that file is the point.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const {
  canonicalizeAwardCategory,
  dedupeCategoryArray,
  canonicalizeWinnerNames,
  findSynonymDuplicates,
} = require('../../scripts/lib/award-category-canonical.js');

const AWARDS_FILE = path.join(__dirname, '..', '..', 'data', 'awards.json');
const awards = JSON.parse(fs.readFileSync(AWARDS_FILE, 'utf8'));

describe('canonicalizeAwardCategory — per-ceremony rules', () => {
  it('collapses DD/OCC "Direction of a X" → "Director of a X"', () => {
    assert.equal(canonicalizeAwardCategory('dramadesk', 'Outstanding Direction of a Musical'), 'Outstanding Director of a Musical');
    assert.equal(canonicalizeAwardCategory('outerCriticsCircle', 'Outstanding Direction of a Play'), 'Outstanding Director of a Play');
    assert.equal(canonicalizeAwardCategory('outerCriticsCircle', 'Outstanding Director of Play'), 'Outstanding Director of a Play');
  });

  it('strips OCC "(Broadway or Off-Broadway)" parenthetical', () => {
    assert.equal(canonicalizeAwardCategory('outerCriticsCircle', 'Outstanding Book of a Musical (Broadway or Off-Broadway)'), 'Outstanding Book of a Musical');
    assert.equal(canonicalizeAwardCategory('outerCriticsCircle', 'Outstanding New Score (Broadway or Off-Broadway)'), 'Outstanding New Score');
  });

  it('collapses DL "Distinguished Performance" → "Distinguished Performance Award" (chip contract form)', () => {
    assert.equal(canonicalizeAwardCategory('dramaLeague', 'Distinguished Performance'), 'Distinguished Performance Award');
  });

  it('does NOT rewrite Drama League / Tony "Direction" (correct name there)', () => {
    assert.equal(canonicalizeAwardCategory('dramaLeague', 'Outstanding Direction of a Musical'), 'Outstanding Direction of a Musical');
    assert.equal(canonicalizeAwardCategory('tony', 'Best Direction of a Musical'), 'Best Direction of a Musical');
  });
});

describe('dedupeCategoryArray — collapse synonyms, keep real repeats', () => {
  it('collapses two variants of one award to a single canonical entry', () => {
    const out = dedupeCategoryArray('dramadesk', ['Outstanding Direction of a Musical', 'Outstanding Director of a Musical']);
    assert.deepEqual(out, ['Outstanding Director of a Musical']);
  });

  it('preserves exact-string repeats (multiple nominees in one category)', () => {
    const out = dedupeCategoryArray('tony', ['Best Featured Actor in a Musical', 'Best Featured Actor in a Musical']);
    assert.deepEqual(out, ['Best Featured Actor in a Musical', 'Best Featured Actor in a Musical']);
  });

  it('is idempotent', () => {
    const once = dedupeCategoryArray('outerCriticsCircle', ['Outstanding Direction of a Play', 'Outstanding Director of a Play']);
    const twice = dedupeCategoryArray('outerCriticsCircle', once);
    assert.deepEqual(once, twice);
  });
});

describe('canonicalizeWinnerNames — keys canonicalized + merged', () => {
  it('merges names under collapsed keys', () => {
    const out = canonicalizeWinnerNames('dramaLeague', {
      'Distinguished Performance': ['Joshua Henry'],
      'Distinguished Performance Award': ['Joshua Henry'],
    });
    assert.deepEqual(out, { 'Distinguished Performance Award': ['Joshua Henry'] });
  });
});

describe('data gate — data/awards.json has no synonym duplicates', () => {
  it('findSynonymDuplicates(shows) is empty', () => {
    const dupes = findSynonymDuplicates(awards.shows || awards);
    assert.equal(dupes.length, 0,
      `Found ${dupes.length} synonym-duplicate categor(ies). Run: node scripts/canonicalize-award-categories.js\n` +
      JSON.stringify(dupes.slice(0, 10), null, 2));
  });
});
