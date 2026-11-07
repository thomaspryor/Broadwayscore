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

test('resolveCheckPaths refuses only year-less ids; near misses warn at filing; no shows.json fails open', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bsid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bare = 'node scripts/lib/verify-data-backfill.js --show=cats --reviews=1';
  const near = 'node scripts/lib/verify-data-backfill.js --show=dinosaurs-off-broadway-2026 --reviews=1';
  assert.equal(resolveCheckPaths(bare, { repoRoot: root }).ok, true);
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data', 'shows.json'), JSON.stringify({ shows: [...KNOWN, 'cats-west-end-2015'].map((id) => ({ id })) }));
  const r = resolveCheckPaths(bare, { repoRoot: root });
  assert.equal(r.ok, false);
  assert.match(r.reason, /cats-west-end-2015/);
  // A near miss may be a new production: dispatch is not refused.
  assert.equal(resolveCheckPaths(near, { repoRoot: root }).ok, true);
  const { armingWarning } = require('./card-arming-warning.js');
  const w = armingWarning(`## Acceptance criteria\n\n\`${near}\``, { repoRoot: root });
  assert.match(String(w), /the-dinosaurs-off-broadway-2026/);
});

// Keep this regression deterministic and independent of the private corpus.
// Real-data coverage is measured separately when running the card.
test('new-production siblings across title and market shapes are never blocking misses', () => {
  const ids = [...KNOWN, 'cats-west-end-2015', 'cats-regional-2026',
    'hamlet-regional-2026', 'hamlet-off-broadway-2025',
    'the-ask-tour-2026', 'photograph-51-west-end-2015'];
  const known = new Set(ids);
  const blocked = [];
  for (const id of ids) {
    const m = /^(.*)-(\d{4})$/.exec(id);
    if (!m) continue;
    for (const sib of [`${m[1]}-${Number(m[2]) + 1}`, `${m[1].replace(/-(off-broadway|west-end|regional|tour)$/, '')}-off-broadway-${m[2]}`]) {
      if (known.has(sib)) continue;
      const r = backfillShowIdNearMisses(`node scripts/lib/verify-data-backfill.js --show=${sib}`, { showIds: ids });
      if (r && r.blocking) blocked.push(sib);
    }
  }
  assert.deepEqual(blocked, []);
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
