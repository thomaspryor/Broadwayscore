import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ibdb-dates destructures serpQuery at load, so the stub must be in the
// require cache before it is required.
let serp = async () => null;
const discoveryPath = require.resolve('../../scripts/lib/url-discovery.js');
require.cache[discoveryPath] = {
  id: discoveryPath, filename: discoveryPath, loaded: true,
  exports: { serpQuery: (...args) => serp(...args) },
};
const { checkIBDBForPriorProductions } = require('../../scripts/lib/ibdb-dates.js');

test('every search failing is not a "not a revival" finding (BRO-5975)', async () => {
  serp = async () => null;
  assert.equal((await checkIBDBForPriorProductions('La Boheme', { currentYear: 2026 })).searchFailed, true);
  serp = async () => { throw new Error('quota'); };
  assert.equal((await checkIBDBForPriorProductions('La Boheme', { currentYear: 2026 })).searchFailed, true);
});

test('a search that ran and found nothing is a real no-finding', async () => {
  serp = async () => [];
  const r = await checkIBDBForPriorProductions('La Boheme', { currentYear: 2026 });
  assert.equal(r.isRevival, false);
  assert.equal(r.searchFailed, undefined);
});

test('one query failing while the other ran is still a real search', async () => {
  let n = 0;
  serp = async () => (n++ === 0 ? null : []);
  assert.equal((await checkIBDBForPriorProductions('La Boheme', { currentYear: 2026 })).searchFailed, undefined);
});
