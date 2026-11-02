import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { backfillShowIdNearMisses, nearMissIds } = require('./backfill-show-id-check.js');
const { resolveCheckPaths } = require('./check-paths.js');

const KNOWN = [
  'laowang-a-chinatown-king-lear-off-broadway-2025',
  'the-dinosaurs-off-broadway-2026',
  'the-monsters-off-broadway-2026',
  'school-girls-or-the-african-mean-girls-play-2026',
  'marjorie-prime-2025',
  'hamlet-off-broadway-2026',
  'the-ask-off-broadway-2026',
];

// The five guessed ids BRO-6736 was filed with (four are near misses).
test('guessed ids that extend a real title are reported with the real id', () => {
  const cmd = 'node scripts/lib/verify-data-backfill.js --show=the-ask-off-broadway-2026,laowang-off-broadway-2026,dinosaurs-off-broadway-2026,monsters-off-broadway-2026,school-girls-off-broadway-2026 --reviews=1';
  const r = backfillShowIdNearMisses(cmd, { showIds: KNOWN });
  assert.ok(r);
  assert.deepEqual(r.misses.map((m) => [m.id, m.suggestions]), [
    ['laowang-off-broadway-2026', ['laowang-a-chinatown-king-lear-off-broadway-2025']],
    ['dinosaurs-off-broadway-2026', ['the-dinosaurs-off-broadway-2026']],
    ['monsters-off-broadway-2026', ['the-monsters-off-broadway-2026']],
    ['school-girls-off-broadway-2026', ['school-girls-or-the-african-mean-girls-play-2026']],
  ]);
  assert.match(r.reason, /did you mean the-dinosaurs-off-broadway-2026/);
});

test('a new production of an existing title, or a brand-new show, is allowed', () => {
  assert.deepEqual(nearMissIds('hamlet-off-broadway-2027', KNOWN), []);
  assert.deepEqual(nearMissIds('marjorie-prime-off-broadway-2026', KNOWN), []);
  assert.equal(backfillShowIdNearMisses('node scripts/lib/verify-data-backfill.js --show=brand-new-musical-2027', { showIds: KNOWN }), null);
});

test('a title more than a year away is not a near miss', () => {
  assert.deepEqual(nearMissIds('laowang-off-broadway-2028', KNOWN), []);
});

test('other check forms and existing ids pass through', () => {
  assert.equal(backfillShowIdNearMisses('node --test scripts/lib/x.test.mjs', { showIds: KNOWN }), null);
  assert.equal(backfillShowIdNearMisses('node scripts/lib/verify-data-backfill.js --show=the-ask-off-broadway-2026', { showIds: KNOWN }), null);
});

test('resolveCheckPaths refuses a near-miss id and fails open without shows.json', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bsid-'));
  const cmd = 'node scripts/lib/verify-data-backfill.js --show=dinosaurs-off-broadway-2026 --reviews=1';
  assert.equal(resolveCheckPaths(cmd, { repoRoot: root }).ok, true);
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data', 'shows.json'), JSON.stringify({ shows: KNOWN.map((id) => ({ id })) }));
  const r = resolveCheckPaths(cmd, { repoRoot: root });
  assert.equal(r.ok, false);
  assert.match(r.reason, /the-dinosaurs-off-broadway-2026/);
});

// BRO-6396 / BRO-6716 / BRO-6794 shapes: titles, market names and "all" in place of ids.
test('an id with no year is never a show id: reported, with same-title ids', () => {
  const known = [...KNOWN, 'photograph-51-west-end-2015', 'cats-west-end-2015'];
  const r = backfillShowIdNearMisses('node scripts/lib/verify-data-backfill.js --show=photograph-51,cats,all,1984 --reviews=1', { showIds: known });
  assert.deepEqual(r.misses.map((m) => [m.id, m.suggestions]), [
    ['photograph-51', ['photograph-51-west-end-2015']],
    ['cats', ['cats-west-end-2015']],
    ['all', []],
    ['1984', []],
  ]);
  assert.match(r.reason, /all \(not a show id/);
});
