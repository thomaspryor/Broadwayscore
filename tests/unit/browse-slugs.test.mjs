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
import { createRequire } from 'node:module';
import { getBrowseSlug, getSeasonSlug } from '../../src/lib/browse-slugs';

const require = createRequire(import.meta.url);
const { getSeasonForDate } = require('../../scripts/lib/broadway-seasons.js');

const CATEGORIES = ['broadway', 'west-end', 'off-west-end', 'off-broadway', undefined];

// Regression guard (2026-08-30): `new Date("2026-07-01")` parses as UTC
// midnight, which reads back as June 30 in America/New_York — misrouting the
// season-boundary anchor date to the PRIOR season on the one day a year the
// boundary itself falls on. Fixed to parse "YYYY-MM-DD" components directly;
// scripts/lib/broadway-seasons.js had the identical bug (see its own test).
test('getSeasonSlug resolves the exact July 1 boundary to the NEW season, not the prior one', () => {
  assert.equal(getSeasonSlug('broadway', '2026-07-01'), '2026-2027-broadway-season');
  assert.equal(getSeasonSlug('broadway', '2026-06-30'), '2025-2026-broadway-season');
  assert.equal(getSeasonSlug('off-broadway', '2026-01-01'), '2025-2026-broadway-season');
});

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

// BRO-2563: getSeasonSlug used to reimplement the Jul1-Jun30 boundary inline
// instead of delegating to scripts/lib/broadway-seasons.js's getSeasonForDate
// (both independently carried, and independently fixed, the same UTC/local
// boundary bug on 2026-08-30). Sweep a full calendar year — including a leap
// day — proving the two call sites agree on every date, not just the
// hand-picked boundary dates above, so a future re-fork of this logic would
// have to break this test to reintroduce drift.
test('getSeasonSlug agrees with broadway-seasons.js getSeasonForDate for every day of a full year', () => {
  const start = new Date(Date.UTC(2027, 0, 1)); // 2027 is a leap-adjacent year; sweep includes 2028-02-29
  for (let i = 0; i < 366 * 2; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    const dateStr = d.toISOString().slice(0, 10);
    const expected = `${getSeasonForDate(dateStr)}-broadway-season`;
    assert.equal(getSeasonSlug('broadway', dateStr), expected, `mismatch at ${dateStr}`);
  }
});

test('regression: special/opera never fall through to the plays/dramas page', () => {
  for (const category of CATEGORIES) {
    const playsSlug = getBrowseSlug(category, 'play');
    assert.notEqual(getBrowseSlug(category, 'special'), playsSlug, `category=${category}`);
    assert.notEqual(getBrowseSlug(category, 'opera'), playsSlug, `category=${category}`);
  }
});
