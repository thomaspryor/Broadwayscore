import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { planOrphanCastPrune } = require('../../scripts/lib/orphan-cast-files.js');
const { urlCarriesShowSlug } = require('../../scripts/audit-cast-contamination.js');

const bigShows = Array.from({ length: 600 }, (_, i) => `show-${i}-2026`);

test('prunes only cast files whose show is gone', () => {
  const plan = planOrphanCastPrune([...bigShows.slice(0, 100), 'spamalot-off-broadway-2026'], bigShows);
  assert.deepEqual(plan, { prune: ['spamalot-off-broadway-2026'], refused: null });
});

test('refuses on a stub shows.json (cloud bootstrap fallback) so data/cast cannot be wiped', () => {
  const plan = planOrphanCastPrune(['a-2026', 'b-2026'], ['a-2026']);
  assert.equal(plan.prune.length, 0);
  assert.match(plan.refused, /stub/);
});

test('refuses when an implausible share would be pruned', () => {
  const ids = Array.from({ length: 100 }, (_, i) => `ghost-${i}`);
  const plan = planOrphanCastPrune(ids, bigShows);
  assert.equal(plan.prune.length, 0);
  assert.match(plan.refused, /would be pruned/);
});

test('SRC_URL_NO_TITLE: BWW paths that split the title still carry the show slug', () => {
  assert.equal(urlCarriesShowSlug('https://www.broadwayworld.com/shows/kramer/fauci-335948/cast', 'kramerfauci-off-broadway-2026'), true);
  assert.equal(urlCarriesShowSlug('https://www.broadwayworld.com/shows/ai-yah-goy-vey!-335828/cast', 'ai-yah-goy-vey-off-broadway-2026'), true);
  assert.equal(urlCarriesShowSlug('https://www.instagram.com/p/DcbphV2JHrG/', 'day-of-the-hog-off-broadway-2026'), false);
  assert.equal(urlCarriesShowSlug('https://themusicmantour.com/cast/', 'cats-2026'), false);
});
