import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { applyDropOrphanKey } = require('./orphan-key-action.js');

// A plausible shows.json: the action refuses a stub below MIN_PLAUSIBLE_SHOWS.
const filler = Array.from({ length: 120 }, (_, i) => `filler-show-${i}`);
const ctx = () => ({ liveIds: new Set(['hamilton-2015', 'morgan-bassichis-can-i-be-frank-off-broadway-2026', ...filler]), retiredIds: new Set(['old-junk-2026']) });
const base = { file: 'audience-buzz.json', reason: 'orphan of a renamed show (BRO-3248)' };

const commercialCtx = () => ({ ...ctx(), liveSlugs: new Set(['hamilton', 'mamma-mia-2001']) });
const commercialAction = { file: 'commercial.json', showId: '860', reason: 'BRO-4623: orphan research metadata without a live show' };

test('drops an orphan commercial key without changing live records', () => {
  const map = { '860': { designation: 'TBD' }, hamilton: { recouped: true } };
  assert.equal(applyDropOrphanKey(map, commercialAction, commercialCtx()).ok, true);
  assert.deepEqual(map, { hamilton: { recouped: true } });
});

test('commercial deletion protects both live slugs and live IDs', () => {
  for (const showId of ['hamilton', 'hamilton-2015', 'mamma-mia-2001']) {
    const map = { [showId]: { designation: 'TBD' } };
    const before = structuredClone(map);
    assert.equal(applyDropOrphanKey(map, { ...commercialAction, showId }, commercialCtx()).ok, false);
    assert.deepEqual(map, before);
  }
});

test('commercial deletion refuses missing slug context and a truncated shows list', () => {
  for (const context of [ctx(), { ...commercialCtx(), liveSlugs: new Set() }, { ...commercialCtx(), liveIds: new Set(['x']) }]) {
    const map = { '860': { designation: 'TBD' } };
    assert.equal(applyDropOrphanKey(map, commercialAction, context).ok, false);
    assert.ok(map['860']);
  }
});

test('commercial orphan action only deletes, never moves research onto another show', () => {
  const map = { '860': { designation: 'TBD' } };
  assert.equal(applyDropOrphanKey(map, { ...commercialAction, renameTo: 'hamilton' }, commercialCtx()).ok, false);
  assert.deepEqual(Object.keys(map), ['860']);
});

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
