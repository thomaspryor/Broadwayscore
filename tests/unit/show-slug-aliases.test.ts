/**
 * getShowBySlug() alias fallback (2026 data audit, S5-T7).
 *
 * src/middleware.ts redirects /show/<old id or merged-row alias> to the
 * canonical slug; routes with no middleware (api/badge, embed,
 * opengraph-image) rely on getShowBySlug() resolving the same inputs.
 * findShowByIdOrAlias() is the pure rule (required, not copied — CLAUDE.md
 * §15); the getShowBySlug cases run against the real shows.json.
 *
 * Run: npx tsx --test tests/unit/show-slug-aliases.test.ts
 */
// TESTS-VS-DERIVED-DATA-EXEMPT: structural — the real-data cases only assert that whatever id/alias exists in the live shows.json resolves through getShowBySlug; no factual value is pinned.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { findShowByIdOrAlias, getShowBySlug, getAllShows } from '../../src/lib/data-core';

const require = createRequire(import.meta.url);

type Row = { id: string; slug: string; aliases?: string[] };
const showsData = require('../../data/shows.json') as { shows: Row[] };

const ROWS: Row[] = [
  { id: 'hamilton-2015', slug: 'hamilton-2015' },
  { id: 'hamilton-west-end-2017', slug: 'hamilton-west-end' },
  {
    id: 'the-emporium-off-broadway-2025',
    slug: 'the-emporium-off-broadway',
    aliases: ['thornton-wilders-the-emporium-off-broadway-2026', 'thornton-wilders-the-emporium-off-broadway'],
  },
  // Lists another row's id as an alias — the id match must win.
  { id: 'decoy-2026', slug: 'decoy', aliases: ['hamilton-west-end-2017'] },
];

describe('findShowByIdOrAlias', () => {
  test('a year-suffixed id resolves when the slug is year-less', () => {
    assert.equal(findShowByIdOrAlias(ROWS, 'hamilton-west-end-2017')?.id, 'hamilton-west-end-2017');
  });

  test("a merged row's full old id resolves", () => {
    assert.equal(findShowByIdOrAlias(ROWS, 'thornton-wilders-the-emporium-off-broadway-2026')?.id, 'the-emporium-off-broadway-2025');
  });

  test("a merged row's year-less old slug resolves", () => {
    assert.equal(findShowByIdOrAlias(ROWS, 'thornton-wilders-the-emporium-off-broadway')?.id, 'the-emporium-off-broadway-2025');
  });

  test("an id match wins over another row's alias", () => {
    assert.equal(findShowByIdOrAlias(ROWS, 'hamilton-west-end-2017')?.id, 'hamilton-west-end-2017');
    assert.notEqual(findShowByIdOrAlias(ROWS, 'hamilton-west-end-2017')?.id, 'decoy-2026');
  });

  test("misses: unknown, empty, and a current slug (exact matches are the caller's job)", () => {
    assert.equal(findShowByIdOrAlias(ROWS, 'nope'), undefined);
    assert.equal(findShowByIdOrAlias(ROWS, ''), undefined);
    assert.equal(findShowByIdOrAlias(ROWS, 'hamilton-west-end'), undefined);
  });

  test('rows without aliases, or with a malformed aliases field, are tolerated', () => {
    const rows: Row[] = [{ id: 'a-2020', slug: 'a', aliases: 'not-an-array' as unknown as string[] }];
    assert.equal(findShowByIdOrAlias(rows, 'x'), undefined);
    assert.equal(findShowByIdOrAlias(rows, 'a-2020')?.id, 'a-2020');
    assert.equal(findShowByIdOrAlias([], 'a-2020'), undefined);
  });
});

describe('getShowBySlug fallback (real shows.json)', () => {
  const rows = showsData.shows;
  const liveSlugs = new Set(rows.map((s) => s.slug));
  const liveIds = new Set(rows.map((s) => s.id));
  const aliased = rows.filter((s) => Array.isArray(s.aliases) && s.aliases.length > 0);

  test('an exact slug still wins', () => {
    const show = getAllShows()[0];
    assert.equal(getShowBySlug(show.slug)?.id, show.id);
  });

  test("a merged row's aliases resolve to the canonical row", { skip: aliased.length === 0 ? 'no shows.json rows carry aliases' : false }, () => {
    let checked = 0;
    for (const row of aliased.slice(0, 5)) {
      for (const alias of row.aliases as string[]) {
        // A live slug or another row's id outranks an alias, by design.
        if (liveSlugs.has(alias) || liveIds.has(alias)) continue;
        const hit = getShowBySlug(alias);
        assert.equal(hit?.id, row.id, `alias ${alias} should resolve to ${row.id}`);
        checked += 1;
      }
    }
    assert.ok(checked > 0, 'at least one alias was exercised');
  });

  test('a year-suffixed id resolves to its year-less slug row', () => {
    const candidates = rows.filter((s) => s.id !== s.slug && !liveSlugs.has(s.id)).slice(0, 3);
    assert.ok(candidates.length > 0, 'shows.json has rows whose id carries a year the slug omits');
    for (const row of candidates) {
      assert.equal(getShowBySlug(row.id)?.id, row.id, `id ${row.id} should resolve to its own row`);
    }
  });

  test('an unknown slug is still undefined', () => {
    assert.equal(getShowBySlug('this-show-does-not-exist-xyz-123'), undefined);
  });
});
