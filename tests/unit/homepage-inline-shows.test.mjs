/**
 * BRO-4872: the homepage must not inline closed West End shows.
 *
 * src/app/page.tsx used to pass every scored West End show (closed included)
 * as the westEndShows prop, only so homepage search could find them. The West
 * End historical backfill promotes closed seasons in bulk, so each season grew
 * the homepage document (~2.7KB per show): 183 closed shows were inlined on
 * 2026-10-08 and tests/e2e/page-weight-budget.spec.ts went red on main at
 * 1,038,427 bytes vs its 1,020,000 budget. Closed West End shows now come from
 * public/data/west-end-archive.json, fetched with homepage-archive.json.
 *
 * The e2e budget only catches this against production after a deploy; these
 * assertions catch the wiring regressing at PR time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function weShowsFilter(src) {
  const start = src.indexOf('const weShows = getWestEndShows().filter(');
  assert.notEqual(start, -1, 'weShows = getWestEndShows().filter( not found in src/app/page.tsx');
  return src.slice(start, src.indexOf(');', start));
}

test('page.tsx inlines only non-closed West End shows', () => {
  // Must be the first conjunct of the filter (an `||` alternative would not exclude closed rows).
  assert.match(weShowsFilter(read('src/app/page.tsx')), /\.filter\(s =>\s*s\.status !== 'closed' &&/);
});

test('page.tsx cache-busts on the West End archive too', () => {
  assert.match(read('src/app/page.tsx'), /public\/data\/west-end-archive\.json/);
});

test('HomePageClient fetches the West End archive and searches it', () => {
  const src = read('src/components/HomePageClient.tsx');
  assert.match(src, /['`/]west-end-archive\.json/);
  const search = src.slice(src.indexOf('const allShowsForSearch'), src.indexOf('const fuseDataRef'));
  assert.match(search, /\.\.\.\(?westEndArchiveShows\b/, 'allShowsForSearch must spread the lazy West End archive into the searched list');
});

test('prebuild regenerates the West End archive', () => {
  assert.match(read('scripts/prebuild.sh'), /^node scripts\/generate-west-end-archive\.js$/m);
});

test('west-end-archive.json holds closed London shows only, no duplicates', () => {
  const rows = JSON.parse(read('public/data/west-end-archive.json'));
  assert.ok(Array.isArray(rows));
  // An empty archive would pass the checks below vacuously and silently drop
  // every closed London show from homepage search.
  assert.ok(rows.length > 0, 'west-end-archive.json is empty');
  const bad = rows.filter((r) => r.status !== 'closed' || !['west-end', 'off-west-end'].includes(r.category));
  assert.deepEqual(bad.map((r) => `${r.id} ${r.status} ${r.category}`), []);
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
});
