// TESTS-VS-DERIVED-DATA-EXEMPT: asserts a floor on the city field itself, which lives only in shows.json (set by the venue-metro table), not a fact derived from precursors or review texts
// BRO-6517 acceptance: the Chicago hub's inputs exist in real data.
// The sectioning logic itself is tested in city-hub.test.ts (src/lib/city-hub.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

test('Chicago regional shows carry city chicago-il (core data)', { skip: !existsSync(new URL('data/shows.json', root)) }, () => {
  const parsed = JSON.parse(read('data/shows.json'));
  const shows = Array.isArray(parsed) ? parsed : parsed.shows;
  const chicago = shows.filter((s) => s.city === 'chicago-il');
  assert.ok(chicago.length >= 6, `expected 6+ shows with city chicago-il, got ${chicago.length}`);
});

test('local Chicago outlets are tagged with metro chicago-il in the registry', () => {
  const reg = JSON.parse(read('data/outlet-registry.json'));
  const outlets = reg.outlets || reg;
  const tagged = Object.values(outlets).filter((o) => o && o.metro === 'chicago-il');
  assert.ok(tagged.length >= 10, `expected 10+ Chicago outlets tagged, got ${tagged.length}`);
});

test('the hub is wired: /tours/[city] reads the hub sections and the archive route exists', () => {
  const hub = read('src/lib/city-hub.ts');
  assert.match(hub, /'chicago-il'/);
  assert.match(read('src/app/tours/[city]/page.tsx'), /sectionHubShows|getCityHubShows/);
  assert.ok(existsSync(new URL('src/app/tours/[city]/archive/page.tsx', root)));
});
