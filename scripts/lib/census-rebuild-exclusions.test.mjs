import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { rebuildExcludedOutlets, filterCensus } = require('./census-rebuild-exclusions.js');
const { censusVerdict } = require('./review-census.js');

const show = { id: 'x-2026', title: 'X', category: 'broadway', openingDate: '2026-01-01', status: 'open' };
function dir(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cre-'));
  for (const [n, o] of Object.entries(files)) fs.writeFileSync(path.join(d, n), JSON.stringify(o));
  return d;
}
const good = { outletId: 'nyt', showId: 'x-2026', fullText: 'x'.repeat(3000), contentTier: 'complete', url: 'https://e.com/a' };

test('wrongProduction-only outlet is excluded; includable and empty outlets are not', () => {
  const d = dir({
    'cititour--a.json': { ...good, outletId: 'cititour', wrongProduction: true },
    'nyt--b.json': good,
  });
  const ex = rebuildExcludedOutlets('x-2026', show, { dir: d });
  assert.deepEqual([...ex], ['cititour']);
  assert.equal(rebuildExcludedOutlets('x-2026', show, { dir: '/nonexistent' }).size, 0);
});

test('outlet with one excluded and one includable file stays in the census', () => {
  const d = dir({
    'cititour--a.json': { ...good, outletId: 'cititour', wrongProduction: true },
    'cititour--b.json': { ...good, outletId: 'cititour', url: 'https://e.com/b' },
  });
  assert.equal(rebuildExcludedOutlets('x-2026', show, { dir: d }).size, 0);
});

test('censusVerdict no longer reports excluded outlets as missing', () => {
  const census = { hadAnySource: true, count: 3, sourcesPresent: ['bww'], entries: [
    { outletId: 'nyt' }, { outletId: 'cititour' }, { outletId: 'nydailynews' } ] };
  const before = censusVerdict(census, new Set(['nyt']));
  assert.equal(before.missing.length, 2);
  const after = censusVerdict(filterCensus(census, new Set(['cititour', 'nydailynews'])), new Set(['nyt']));
  assert.equal(after.missing.length, 0);
  assert.equal(after.verdict, 'complete');
});
