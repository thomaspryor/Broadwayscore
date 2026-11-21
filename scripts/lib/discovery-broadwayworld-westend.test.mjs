// BRO-4850: BWW West End reviews (/westend/article/Review-*) must reach site
// search for London shows, including off-West-End ones like The Hungry Ghost
// (Bush Theatre), which went ~40h undiscovered on 2026-10-06.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ssd = require('./site-search-discovery.js');

const LISTING = 'https://www.broadwayworld.com/westend/local-reviews/';
const HUNGRY_GHOST = 'https://www.broadwayworld.com/westend/article/Review-THE-HUNGRY-GHOST-Bush-Theatre-20261006';
const FIXTURE = `
  <a href="/westend/article/Review-THE-HUNGRY-GHOST-Bush-Theatre-20261006">Review: THE HUNGRY GHOST</a>
  <a href="https://www.broadwayworld.com/westend/article/Review-RENT-Theatre-Royal-Stratford-East-20261008">Review: RENT</a>
  <a href="/westend/article/Photos-First-Look-at-SOMETHING-20261001">Photos</a>
  <a href="/article/Review-Roundup-SOMETHING-Opens-on-Broadway-20261001">US roundup</a>`;
const hungryGhost = { id: 'the-hungry-ghost-off-west-end-2026', title: 'The Hungry Ghost', category: 'off-west-end', type: 'play' };

function primeListing(html) { ssd._sectionCache.set(LISTING, { at: Date.now(), html }); }
beforeEach(() => ssd._sectionCache.clear());

test('extracts only /westend/article/Review-* links, relative or absolute', () => {
  assert.deepEqual(ssd.extractBwwWestEndReviewUrls(FIXTURE), [
    HUNGRY_GHOST,
    'https://www.broadwayworld.com/westend/article/Review-RENT-Theatre-Royal-Stratford-East-20261008',
  ]);
  assert.deepEqual(ssd.extractBwwWestEndReviewUrls(''), []);
});

test('selected for London shows (off-West-End too), never for Broadway', () => {
  assert.ok(ssd.selectApplicableSiteSearchOutlets('west-end', hungryGhost, new Set(), false).includes('broadwayworld-westend'));
  assert.ok(!ssd.selectApplicableSiteSearchOutlets('broadway', { title: 'X', type: 'play' }, new Set(), false).includes('broadwayworld-westend'));
  assert.ok(!ssd.selectApplicableSiteSearchOutlets('west-end', hungryGhost, new Set(['broadwayworld']), false).includes('broadwayworld-westend'),
    'skipped once BroadwayWorld is already found');
});

test('The Hungry Ghost BWW review is discovered as a broadwayworld candidate', async () => {
  primeListing(FIXTURE);
  const results = await ssd.searchOutletSites(hungryGhost.title, ['broadwayworld-westend'], { market: 'west-end', show: hungryGhost, knownUrls: new Set() });
  assert.deepEqual(results.map(r => [r.url, r.outletId, r.source]), [[HUNGRY_GHOST, 'broadwayworld', 'site-search']]);
});

test('one listing serves every show in a run (no refetch while cached)', async () => {
  primeListing(FIXTURE);
  const rent = { id: 'rent-off-west-end-2026', title: 'Rent', category: 'off-west-end', type: 'musical' };
  const a = await ssd.searchOutletSite('broadwayworld-westend', hungryGhost.title, { market: 'west-end', show: hungryGhost });
  const b = await ssd.searchOutletSite('broadwayworld-westend', rent.title, { market: 'west-end', show: rent });
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.match(b[0].url, /Review-RENT-/);
});

test('an empty listing warns instead of failing silently', async (t) => {
  primeListing('<html>blocked</html>');
  const warn = t.mock.method(console, 'warn', () => {});
  const r = await ssd.searchOutletSite('broadwayworld-westend', hungryGhost.title, { market: 'west-end', show: hungryGhost });
  assert.deepEqual(r, []);
  assert.ok(warn.mock.calls.some(c => /BroadwayWorld WE\]: WARNING/.test(c.arguments[0])));
});
