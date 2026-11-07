/**
 * /cast ships only actors at or above the default filter in its HTML and
 * loads the rest from /cast-index.json on demand (BRO-5968). The split must
 * be exact: an actor in neither half disappears from the directory, and one
 * in both shows twice. Imports the real function (CLAUDE.md §15).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitCastIndex, CAST_DEFAULT_MIN_SCORED, type CastIndexProfile } from '../../src/lib/cast-index-split';

function profile(slug: string, scoredShowCount: number, showCount = scoredShowCount): CastIndexProfile {
  return { name: slug, slug, showCount, scoredShowCount, avgScore: null, openShowCount: 0, roles: [], obcCount: 0, headshot: null };
}

test('every profile lands in exactly one half', () => {
  const all = [0, 1, CAST_DEFAULT_MIN_SCORED - 1, CAST_DEFAULT_MIN_SCORED, CAST_DEFAULT_MIN_SCORED + 5]
    .map((n, i) => profile(`p${i}`, n, n + 4));
  const { main, rest } = splitCastIndex(all);
  assert.equal(main.length + rest.length, all.length);
  assert.equal(new Set([...main, ...rest].map(p => p.slug)).size, all.length);
});

test('the default filter threshold decides the half, on scored shows', () => {
  const { main, rest } = splitCastIndex([
    profile('at-threshold', CAST_DEFAULT_MIN_SCORED),
    profile('below', CAST_DEFAULT_MIN_SCORED - 1, 20),
  ]);
  assert.deepEqual(main.map(p => p.slug), ['at-threshold']);
  assert.deepEqual(rest.map(p => p.slug), ['below']);
});
