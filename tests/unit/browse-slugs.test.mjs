/**
 * getBrowseSlug() format discrimination (BRO-183).
 *
 * The old implementation was binary: `const isMusical = type === 'musical'`
 * meant every non-musical type — including `opera` and `special` (concerts,
 * galas, immersive experiences, cabaret, dance) — fell through to the
 * plays/dramas browse page. After the 2026-07-30 label fix (show-format.ts),
 * a `special` show's breadcrumb correctly read "Events" but still linked to
 * best-off-broadway-plays: label and destination disagreed, because no
 * browse page for concerts/operas exists.
 *
 * getBrowseSlug now returns null for opera/special — "no page fits" — and
 * callers (src/app/show/[slug]/page.tsx, WhereItRanks.tsx) render that
 * breadcrumb/link level unlinked instead of guessing a mismatched page.
 *
 * Run: npx tsx --test tests/unit/browse-slugs.test.mjs
 * (imports src/lib/browse-slugs.ts directly — needs the tsx loader, same as
 * every other *.test.mjs that imports a .ts file; registered in
 * tests/unit-test-manifest-tsx.txt, not the plain-node manifest.)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { getBrowseSlug } from '../../src/lib/browse-slugs';

const CATEGORIES = ['broadway', 'west-end', 'off-west-end', 'off-broadway', undefined];

test('musical resolves to a musicals browse page in every category', () => {
  assert.equal(getBrowseSlug('broadway', 'musical'), 'best-broadway-musicals');
  assert.equal(getBrowseSlug('west-end', 'musical'), 'best-west-end-musicals');
  assert.equal(getBrowseSlug('off-west-end', 'musical'), 'best-off-west-end-musicals');
  assert.equal(getBrowseSlug('off-broadway', 'musical'), 'best-off-broadway-musicals');
});

test('play resolves to the plays/dramas browse page in every category', () => {
  assert.equal(getBrowseSlug('broadway', 'play'), 'best-broadway-dramas');
  assert.equal(getBrowseSlug('west-end', 'play'), 'best-west-end-plays');
  assert.equal(getBrowseSlug('off-west-end', 'play'), 'best-off-west-end-plays');
  assert.equal(getBrowseSlug('off-broadway', 'play'), 'best-off-broadway-plays');
});

test('special (concerts, galas, events) returns null — no dedicated browse page exists', () => {
  for (const category of CATEGORIES) {
    assert.equal(getBrowseSlug(category, 'special'), null, `category=${category}`);
  }
});

test('opera returns null — no dedicated browse page exists', () => {
  for (const category of CATEGORIES) {
    assert.equal(getBrowseSlug(category, 'opera'), null, `category=${category}`);
  }
});

test('regression: special/opera never fall through to the plays/dramas page', () => {
  for (const category of CATEGORIES) {
    const playsSlug = getBrowseSlug(category, 'play');
    assert.notEqual(getBrowseSlug(category, 'special'), playsSlug, `category=${category}`);
    assert.notEqual(getBrowseSlug(category, 'opera'), playsSlug, `category=${category}`);
  }
});
