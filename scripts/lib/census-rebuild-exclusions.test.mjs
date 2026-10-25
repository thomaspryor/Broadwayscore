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
  assert.deepEqual([...ex.keys()], ['cititour']);
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
  const after = censusVerdict(filterCensus(census, new Map([['cititour', { urls: new Set() }], ['nydailynews', { urls: new Set() }]])), new Set(['nyt']));
  assert.equal(after.missing.length, 0);
  assert.equal(after.verdict, 'complete');
});

test('content-excluded outlet stays a gap when the census url is a different article', () => {
  const d = dir({ 'cititour--a.json': { ...good, outletId: 'cititour', wrongProduction: true, url: 'https://c.com/old' } });
  const ex = rebuildExcludedOutlets('x-2026', show, { dir: d });
  const census = { hadAnySource: true, count: 2, entries: [
    { outletId: 'cititour', url: 'https://c.com/new' }, { outletId: 'nyt', url: 'https://n.com/1' } ] };
  assert.equal(filterCensus(census, ex).entries.length, 2);
  const same = { ...census, entries: [{ outletId: 'cititour', url: 'http://www.c.com/old/?utm_x=1' }, census.entries[1]] };
  assert.deepEqual(filterCensus(same, ex).entries.map((e) => e.outletId), ['nyt']);
});

test('syndication copy drops its own url; -london variant matches; emptied census stays complete', () => {
  const d = dir({ 'timeout-london--a.json': { ...good, outletId: 'timeout-london', knownSyndicationSecondary: true, wrongShow: true, url: 'https://t.com/a' } });
  const ex = rebuildExcludedOutlets('x-2026', show, { dir: d });
  assert.equal(ex.size, 1);
  const census = { hadAnySource: true, count: 1, entries: [{ outletId: 'timeout', url: 'https://t.com/a' }] };
  const f = filterCensus(census, ex);
  assert.equal(f.entries.length, 0);
  assert.equal(censusVerdict(f, new Set()).verdict, 'complete');
});

test('distinct query-string articles stay distinct; unreadable sibling keeps the outlet', () => {
  const d = dir({ 'a--x.json': { ...good, outletId: 'a', wrongShow: true, url: 'https://A.com/Review?id=old&utm_source=x' } });
  const ex = rebuildExcludedOutlets('x-2026', show, { dir: d });
  const mk = (url) => ({ hadAnySource: true, count: 1, entries: [{ outletId: 'a', url }] });
  assert.equal(filterCensus(mk('https://a.com/Review?id=new'), ex).entries.length, 1);
  assert.equal(filterCensus(mk('http://www.a.com/Review/?id=old'), ex).entries.length, 0);
  fs.writeFileSync(path.join(d, 'a--bad.json'), '{ truncated');
  assert.equal(rebuildExcludedOutlets('x-2026', show, { dir: d }).size, 0);
});
