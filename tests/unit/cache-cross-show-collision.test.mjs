/**
 * BRO-4060: the cross-show collision guard on every showId -> url/slug cache
 * writer (generalising BRO-4055's Show Score fix).
 *
 * Every test requires the real module (CLAUDE.md rule 15). Writers covered:
 *   - shared helper        scripts/lib/cache-collision.js
 *   - Show Score           show-score-url-map.js findConflictingShowId (delegates)
 *   - Playbill             playbill-urls-store.js savePlaybillUrls/applyDelta
 *                          (all four playbill-urls.json writers save through it)
 *   - DTLI                 applyAssignmentsWithoutCollisions (discover-dtli-slugs.js)
 *                          and findConflictingKey (watch-aggregator-urls.js)
 *   - WestEnd              westend-slug-discovery.js discoverWestEndTheatreUrl
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  findConflictingKey,
  applyAssignmentsWithoutCollisions,
  normalizeCacheValue,
} = require('../../scripts/lib/cache-collision.js');
const { findConflictingShowId } = require('../../scripts/lib/show-score-url-map.js');
const store = require('../../scripts/lib/playbill-urls-store.js');
const { discoverWestEndTheatreUrl } = require('../../scripts/lib/westend-slug-discovery.js');

function tmpFile(name, obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-4060-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
  return file;
}
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// ---------------------------------------------------------------- shared helper

test('findConflictingKey: a value owned by another key is a conflict; own value is not', () => {
  const map = { 'death-of-a-salesman-2026': 'death-of-a-salesman-3', 'hamlet-2026': 'hamlet-4' };
  assert.equal(findConflictingKey(map, 'death-of-a-salesman-1999', 'death-of-a-salesman-3'), 'death-of-a-salesman-2026');
  assert.equal(findConflictingKey(map, 'death-of-a-salesman-2026', 'death-of-a-salesman-3'), null);
  assert.equal(findConflictingKey(map, 'giant-2026', 'giant-2'), null);
});

test('findConflictingKey: case, protocol, www and trailing slash do not hide a collision', () => {
  const map = { 'a-2016': 'https://www.Playbill.com/production/she-loves-me-studio-54-2015-2016/' };
  assert.equal(findConflictingKey(map, 'b-1994', 'http://playbill.com/production/she-loves-me-studio-54-2015-2016'), 'a-2016');
  assert.equal(normalizeCacheValue(' HTTPS://www.x.com/a/ '), 'x.com/a');
});

test('findConflictingKey: object entries compare by .url; negative-cache entries claim nothing', () => {
  const map = {
    'avenue-q-2026': { url: 'https://www.westendtheatre.com/5308/shows/avenue-q/', discoveredAt: '2026-01-01' },
    'gone-2026': { notFoundAt: '2026-10-01' },
  };
  assert.equal(findConflictingKey(map, 'avenue-q-2009', 'https://www.westendtheatre.com/5308/shows/avenue-q'), 'avenue-q-2026');
  assert.equal(findConflictingKey(map, 'x', { url: 'https://www.westendtheatre.com/5308/shows/avenue-q/' }), 'avenue-q-2026');
  assert.equal(findConflictingKey(map, 'x', 'https://www.westendtheatre.com/1/shows/other/'), null);
  assert.equal(findConflictingKey(map, 'x', null), null);
  assert.equal(findConflictingKey(map, 'x', ''), null);
  assert.equal(findConflictingKey(undefined, 'x', 'y'), null);
});

test('Show Score findConflictingShowId still behaves as BRO-4055 after delegating', () => {
  const urlMap = { 'she-loves-me-2016': 'https://www.show-score.com/broadway-shows/she-loves-me' };
  assert.equal(findConflictingShowId(urlMap, 'she-loves-me-1994', 'https://www.show-score.com/broadway-shows/she-loves-me/'), 'she-loves-me-2016');
  assert.equal(findConflictingShowId(urlMap, 'she-loves-me-2016', 'https://www.show-score.com/broadway-shows/she-loves-me'), null);
});

// ---------------------------------------------------------------- DTLI batch writer

test('DTLI batch: re-matching a slug its current owner keeps is refused (death-of-a-salesman shape)', () => {
  const map = { 'death-of-a-salesman-2026': 'death-of-a-salesman-3', 'wicked-2003': 'wicked' };
  const { map: next, refused } = applyAssignmentsWithoutCollisions(map, { 'death-of-a-salesman-1999': 'death-of-a-salesman-3' });
  assert.deepEqual(refused, [{ key: 'death-of-a-salesman-1999', value: 'death-of-a-salesman-3', owner: 'death-of-a-salesman-2026' }]);
  assert.equal(next['death-of-a-salesman-1999'], undefined);
  assert.equal(next['death-of-a-salesman-2026'], 'death-of-a-salesman-3');
  assert.equal(map['death-of-a-salesman-1999'], undefined, 'input map must not be mutated');
});

test('DTLI batch: a swap inside one --force batch is allowed (old owner releases first)', () => {
  const map = { 'giant-2026': 'giant', 'giant-2009': 'giant-2' };
  const { map: next, refused } = applyAssignmentsWithoutCollisions(map, { 'giant-2026': 'giant-2', 'giant-2009': 'giant' });
  assert.deepEqual(refused, []);
  assert.deepEqual(next, { 'giant-2026': 'giant-2', 'giant-2009': 'giant' });
});

test('DTLI batch: a refused re-point keeps the previous slug; two new claimants of one slug -> first wins', () => {
  const map = { 'hamlet-2008': 'hamlet', 'hamlet-2026': 'hamlet-3', 'company-2021': 'company-2' };
  const { map: next, refused } = applyAssignmentsWithoutCollisions(map, {
    'hamlet-2026': 'hamlet', // owned by hamlet-2008, which is not moving
    'frozen-2018': 'frozen-3',
    'frozen-2030': 'frozen-3',
  });
  assert.equal(next['hamlet-2026'], 'hamlet-3', 'refused key keeps its unclaimed previous slug');
  assert.equal(next['hamlet-2008'], 'hamlet');
  assert.equal(next['frozen-2018'], 'frozen-3');
  assert.equal(next['frozen-2030'], undefined);
  assert.deepEqual(refused.map((r) => [r.key, r.owner]), [['hamlet-2026', 'hamlet-2008'], ['frozen-2030', 'frozen-2018']]);
});

// ---------------------------------------------------------------- Playbill store

const OPEN = { guard: () => ({ ok: true, reason: null }) };
const PB = (slug) => `https://playbill.com/production/${slug}`;

test('Playbill store: a set whose URL another show owns is refused, reported and reverted', () => {
  const file = tmpFile('playbill-urls.json', { shows: { 'she-loves-me-2016': PB('she-loves-me-studio-54-2015-2016') }, lastUpdated: null });
  const s = store.loadPlaybillUrls(file);
  s.data.shows['she-loves-me-1994'] = PB('she-loves-me-studio-54-2015-2016/');
  s.data.shows['wicked-2003'] = PB('wicked-gershwin-theatre-2003');
  const r = store.savePlaybillUrls(file, s.data, s.snapshot, OPEN);
  const disk = readJson(file).shows;
  assert.equal(disk['she-loves-me-1994'], undefined);
  assert.equal(disk['wicked-2003'], PB('wicked-gershwin-theatre-2003'));
  assert.equal(r.sets, 1);
  assert.equal(r.refused.length, 1);
  assert.match(r.refused[0].reason, /cross-show-collision.*she-loves-me-2016/);
  assert.equal(s.data.shows['she-loves-me-1994'], undefined, 'working copy reverted');
});

test('Playbill store: a peer claiming the URL after our load still blocks our set (checked under the lock)', () => {
  const file = tmpFile('playbill-urls.json', { shows: {}, lastUpdated: null });
  const a = store.loadPlaybillUrls(file);
  const b = store.loadPlaybillUrls(file);
  a.data.shows['cabaret-2024'] = PB('cabaret-august-wilson-2024');
  store.savePlaybillUrls(file, a.data, a.snapshot, OPEN);
  b.data.shows['cabaret-1998'] = PB('cabaret-august-wilson-2024');
  const r = store.savePlaybillUrls(file, b.data, b.snapshot, OPEN);
  assert.deepEqual(Object.keys(readJson(file).shows), ['cabaret-2024']);
  assert.equal(r.refused[0].id, 'cabaret-1998');
});

test('Playbill store: a colliding REPLACEMENT drops the evicted old URL; moving a URL between ids in one save is allowed', () => {
  const file = tmpFile('playbill-urls.json', {
    shows: { 'x-2026': PB('x-dead-slug'), 'y-2026': PB('y-real'), 'm-old': PB('m-page') },
    lastUpdated: null,
  });
  const s = store.loadPlaybillUrls(file);
  s.data.shows['x-2026'] = PB('y-real'); // collides with y-2026
  delete s.data.shows['m-old'];
  s.data.shows['m-new'] = PB('m-page'); // freed by the delete in the same save
  const r = store.savePlaybillUrls(file, s.data, s.snapshot, OPEN);
  const disk = readJson(file).shows;
  assert.equal(disk['x-2026'], undefined, 'old dead URL is not restored');
  assert.equal(disk['y-2026'], PB('y-real'));
  assert.equal(disk['m-new'], PB('m-page'));
  assert.equal(disk['m-old'], undefined);
  assert.deepEqual(r.refused.map((x) => x.id), ['x-2026']);
  assert.equal(s.data.shows['x-2026'], undefined);
});

// ---------------------------------------------------------------- WestEnd discovery

function wetMap(shows) {
  return tmpFile('westend-slug-map.json', { _meta: { lastUpdated: null }, shows });
}
const serpReturning = (url, title) => async () => [{ url, title }];

test('WestEnd: SERP result already owned by another show is refused and negative-cached', async () => {
  const owned = 'https://www.westendtheatre.com/5308/shows/avenue-q/';
  const file = wetMap({ 'avenue-q-2026': { url: owned, discoveredAt: '2026-01-01' } });
  const got = await discoverWestEndTheatreUrl({ id: 'avenue-q-2006', title: 'Avenue Q' }, file, {
    serpQuery: serpReturning(owned, 'Avenue Q tickets'),
  });
  assert.equal(got, null);
  const entry = readJson(file).shows['avenue-q-2006'];
  assert.equal(entry.url, undefined);
  assert.equal(entry.collidedWith, 'avenue-q-2026');
  assert.ok(entry.notFoundAt);
});

test('WestEnd: an unclaimed SERP result is cached normally', async () => {
  const file = wetMap({ 'avenue-q-2026': { url: 'https://www.westendtheatre.com/5308/shows/avenue-q/' } });
  const url = 'https://www.westendtheatre.com/313823/shows/stranger-things-the-first-shadow-tickets/';
  const got = await discoverWestEndTheatreUrl({ id: 'stranger-things-2023', title: 'Stranger Things The First Shadow' }, file, {
    serpQuery: serpReturning(url, 'Stranger Things The First Shadow tickets'),
  });
  assert.equal(got, url);
  assert.equal(readJson(file).shows['stranger-things-2023'].url, url);
});

test('WestEnd: a negative-cache entry for another show does not block a URL', async () => {
  const file = wetMap({ 'other-2026': { notFoundAt: '2026-10-01' } });
  const url = 'https://www.westendtheatre.com/42/shows/hadestown/';
  const got = await discoverWestEndTheatreUrl({ id: 'hadestown-2024', title: 'Hadestown' }, file, {
    serpQuery: serpReturning(url, 'Hadestown tickets'),
  });
  assert.equal(got, url);
});
