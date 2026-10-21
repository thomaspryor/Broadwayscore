/**
 * BRO-5854: opera has its own /opera page and homepage "At the Met" shelf, so
 * it must not appear in the Off-Broadway market (shelves, list, counts,
 * JSON-LD, archive). Imports the real functions (§15).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getAllOffBroadwayTheaters, getOffBroadwayShows, getOperaShows, isOffBroadwayMarketShow } from '../../src/lib/data-core';

test('getOffBroadwayShows has no opera, getOperaShows still does', () => {
  assert.ok(getOperaShows().length > 0, 'fixture needs opera shows');
  assert.equal(getOffBroadwayShows().filter(s => s.type === 'opera').length, 0);
  assert.ok(getOffBroadwayShows().length > 0);
});

test('isOffBroadwayMarketShow rejects opera and non-OB', () => {
  const base = { category: 'off-broadway' } as any;
  assert.equal(isOffBroadwayMarketShow({ ...base, type: 'play' }), true);
  assert.equal(isOffBroadwayMarketShow({ ...base, type: 'opera' }), false);
  assert.equal(isOffBroadwayMarketShow({ category: 'broadway', type: 'play' } as any), false);
});

test('off-broadway-archive.json has no opera rows', () => {
  const archive = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'public/data/off-broadway-archive.json'), 'utf8'));
  assert.equal(archive.filter((s: any) => s.type === 'opera').length, 0);
});

test('Met venue page keeps its opera productions in the theater index', () => {
  const met = getAllOffBroadwayTheaters().find(t => /metropolitan opera/i.test(t.name || ''));
  assert.ok(met, 'Met theater present');
  assert.ok(met!.showCount >= getOperaShows().length, 'venue showCount includes opera');
});
