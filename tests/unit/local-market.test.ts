/**
 * Local-only shows (BRO-6518): Chicago productions from theatreinchicago.com must
 * stay off the homepage, Pre-Broadway shelf, Broadway/West End browse, search and
 * the iOS feeds. This pins the predicate (TS + script mirror) and that every
 * cross-market enumerator applies it.
 *
 * Run: npx tsx --test tests/unit/local-market.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { isLocalOnlyShow, LOCAL_DISCOVERY_SOURCES } from '../../src/lib/local-market';
import { pickRegionalShelf } from '../../src/lib/regional-shelf';

const require = createRequire(import.meta.url);
const js = require('../../scripts/lib/local-market.js');
const root = path.join(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

test('predicate: field or discoverySource marks a show local-only; both mirrors agree', () => {
  const cases: Array<[any, boolean]> = [
    [{ localOnly: true }, true],
    [{ discoverySource: 'theatreinchicago' }, true],
    [{ localOnly: false, discoverySource: 'guardian-review' }, false],
    [{ category: 'regional', discoverySource: 'playbill' }, false],
    [{}, false],
    [null, false],
    [undefined, false],
  ];
  for (const [show, want] of cases) {
    assert.equal(isLocalOnlyShow(show), want, JSON.stringify(show));
    assert.equal(js.isLocalOnlyShow(show), want, `js ${JSON.stringify(show)}`);
  }
  assert.deepEqual(LOCAL_DISCOVERY_SOURCES, js.LOCAL_DISCOVERY_SOURCES);
});

test('the shelf pick never gets a local show when fed getRegionalShows()-style input', () => {
  const tryout = { id: 'a-regional-2026', status: 'open', category: 'regional', openingDate: '2026-09-01', criticScore: { score: 80, reviewCount: 6, tier1Count: 1, tier2Count: 1 } };
  const local = { id: 'b-regional-2026', status: 'open', category: 'regional', localOnly: true, openingDate: '2026-10-01', criticScore: { score: 90, reviewCount: 8, tier1Count: 1, tier2Count: 1 } };
  // getRegionalShows() filters with isLocalOnlyShow before the shelf sees the list.
  const pool = [tryout, local].filter((s) => !isLocalOnlyShow(s));
  assert.deepEqual(pickRegionalShelf(pool, { requireEnoughReviews: true }).map((s) => s.id), ['a-regional-2026']);
});

test('every cross-market enumerator applies the local-only rule', () => {
  const dc = read('src/lib/data-core.ts');
  assert.match(dc, /category === 'regional' && !isUkRegionalShow\(show\) && !isLocalOnlyShow\(show\)/, 'getRegionalShows');
  assert.match(dc, /category === 'regional' && isUkRegionalShow\(show\) && !isLocalOnlyShow\(show\)/, 'getUkRegionalShows');
  assert.match(dc, /if \(isLocalOnlyShow\(show\)\) return 'local'/, 'related-shows bucket');
  assert.match(read('scripts/generate-mobile-data.js'), /!isLocalOnlyShow\(show\)/, 'iOS feed');
  assert.match(read('scripts/generate-mobile-show-details.js'), /isLocalOnlyShow\(showById\.get\(id\)\)/, 'iOS detail index');
  const search = read('scripts/generate-search-shows.js');
  assert.equal((search.match(/isLocalOnlyShow\(show\)/g) || []).length, 2, 'search (live + archive)');
  assert.match(read('src/app/welcome-shows.json/route.ts'), /!isLocalOnlyShow\(s\)/, 'welcome grid');
});

test('add-show accepts the localOnly field', () => {
  const src = read('scripts/lib/add-show-action.js');
  assert.match(src, /'localOnly'/);
});

test('computeShowData carries localOnly/discoverySource through, so the enumerators can see them', () => {
  const { computeShowData } = require('../../src/lib/engine');
  const raw = { id: 'x-regional-2026', title: 'X', slug: 'x-regional-2026', venue: 'Goodman Theatre, Chicago, IL', status: 'open', type: 'play', category: 'regional', market: 'regional', openingDate: '2026-09-01', localOnly: true, discoverySource: 'theatreinchicago' };
  const out = computeShowData(raw, [], [], []);
  assert.equal(out.localOnly, true);
  assert.equal(out.discoverySource, 'theatreinchicago');
  assert.equal(isLocalOnlyShow(out), true);
});
