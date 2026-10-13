import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { applyDropOrphanKey } = require('./orphan-key-action.js');

const ctx = () => ({ liveIds: new Set(['hamilton-2015', 'morgan-bassichis-can-i-be-frank-off-broadway-2026']), retiredIds: new Set(['old-junk-2026']) });
const base = { file: 'audience-buzz.json', reason: 'orphan of a renamed show (BRO-3248)' };

test('drops a non-live key', () => {
  const map = { 'proof-express-test-2026': {}, 'hamilton-2015': {} };
  const r = applyDropOrphanKey(map, { ...base, showId: 'proof-express-test-2026' }, ctx());
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(map), ['hamilton-2015']);
});

test('never touches a live show id', () => {
  const map = { 'hamilton-2015': { x: 1 } };
  const r = applyDropOrphanKey(map, { ...base, showId: 'hamilton-2015' }, ctx());
  assert.equal(r.ok, false);
  assert.ok(map['hamilton-2015']);
});

test('moves a renamed show onto its live id only when that id has no entry', () => {
  const map = { 'can-i-be-frank-off-broadway-2026': { title: 'Can I Be Frank?' } };
  const r = applyDropOrphanKey(map, { ...base, showId: 'can-i-be-frank-off-broadway-2026', renameTo: 'morgan-bassichis-can-i-be-frank-off-broadway-2026' }, ctx());
  assert.equal(r.ok, true);
  assert.equal(map['morgan-bassichis-can-i-be-frank-off-broadway-2026'].title, 'Can I Be Frank?');
  const taken = { a: {}, 'hamilton-2015': {} };
  assert.equal(applyDropOrphanKey(taken, { ...base, showId: 'a', renameTo: 'hamilton-2015' }, ctx()).ok, false);
});

test('refuses missing keys, unknown files, short reasons, retired-to-live moves, empty live set', () => {
  assert.equal(applyDropOrphanKey({}, { ...base, showId: 'nope-2026' }, ctx()).ok, false);
  assert.equal(applyDropOrphanKey({ x: {} }, { ...base, file: 'shows.json', showId: 'x' }, ctx()).ok, false);
  assert.equal(applyDropOrphanKey({ x: {} }, { ...base, reason: 'short', showId: 'x' }, ctx()).ok, false);
  assert.equal(applyDropOrphanKey({ 'old-junk-2026': {} }, { ...base, showId: 'old-junk-2026', renameTo: 'hamilton-2015' }, ctx()).ok, false);
  assert.equal(applyDropOrphanKey({ x: {} }, { ...base, showId: 'x' }, { liveIds: new Set() }).ok, false);
});
