import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { applyDropOrphanKey } = require('./orphan-key-action.js');

// A plausible shows.json: the action refuses a stub below MIN_PLAUSIBLE_SHOWS.
const filler = Array.from({ length: 120 }, (_, i) => `filler-show-${i}`);
const ctx = () => ({ liveIds: new Set(['hamilton-2015', 'morgan-bassichis-can-i-be-frank-off-broadway-2026', ...filler]), retiredIds: new Set(['old-junk-2026']) });
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

test('refuses on a stub shows.json (BRO-5261 retro-review)', () => {
  const map = { 'hamilton-2015': { x: 1 } };
  // A stub without hamilton-2015 must not make hamilton's data look orphaned.
  const r = applyDropOrphanKey(map, { ...base, showId: 'hamilton-2015' }, { liveIds: new Set(['a-show', 'b-show']) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /stub/);
  assert.ok(map['hamilton-2015']);
});

test('execute-approved-fix fails a drop-orphan-key action with a bad file instead of throwing', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(new URL('../execute-approved-fix.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('function executeDropOrphanKey'), src.indexOf('function executeRetitleShow'));
  assert.ok(body.indexOf('DROP_ORPHAN_KEY_FILES.has(action.file)') < body.indexOf('loadJsonFile(rel)'), 'file is checked before it is read');
  assert.match(body, /catch \(e\) \{\s*return \{ ok: false/);
});
