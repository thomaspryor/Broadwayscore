// TESTS-VS-DERIVED-DATA-EXEMPT: fixture-based; isolated tmp dirs, no production data files.
/**
 * BRO-5265: two files that each name the other as crossOutletPrimaryFile (a
 * mutual 2-cycle) used to be BOTH excluded by explainExclusion, so the review
 * vanished from scoring. Exactly one copy must be kept, the same one from
 * either side. Uses the real review-guards / cross-outlet-cycle / audit code.
 *
 * Run: node --test tests/unit/cross-outlet-duplicate-cycle.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.join(import.meta.dirname, '..', '..');
const { explainExclusion } = require(path.join(ROOT, 'scripts/lib/review-guards.js'));
const cycle = require(path.join(ROOT, 'scripts/lib/cross-outlet-cycle.js'));
const AUDIT = path.join(ROOT, 'scripts/audit-duplicate-of-url-mismatch.js');

const BODY = 'A perfectly ordinary review body with more than enough words to pass the text gate.';
let n = 0;
const row = (extra) => ({ url: `https://example${++n}.com/review`, fullText: BODY, ...extra });

function mkShow(files, showId = 'some-show-2016') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xo-cycle-'));
  const dir = path.join(root, showId);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, obj] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), JSON.stringify(obj, null, 2));
  return { root, dir, showId };
}
const explain = (dir, f) => explainExclusion(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), null, path.join(dir, f));
const xo = (showId, primary, extra = {}) => row({ crossOutletDuplicate: true, crossOutletPrimaryFile: `${showId}/${primary}`, ...extra });

test('a mutual crossOutletDuplicate 2-cycle keeps exactly one copy (lexically lower when nothing else decides)', () => {
  const showId = 'some-show-2016';
  const { dir } = mkShow({
    'aaa--unknown.json': xo(showId, 'zzz--unknown.json'),
    'zzz--unknown.json': xo(showId, 'aaa--unknown.json'),
  }, showId);
  assert.equal(explain(dir, 'aaa--unknown.json'), null);
  assert.equal(explain(dir, 'zzz--unknown.json'), 'crossOutletDuplicate');
});

test('bare-name pointers form a cycle too', () => {
  const { dir } = mkShow({
    'aaa--x.json': row({ crossOutletDuplicate: true, crossOutletPrimaryFile: 'zzz--y.json' }),
    'zzz--y.json': row({ crossOutletDuplicate: true, crossOutletPrimaryFile: 'aaa--x.json' }),
  });
  const got = [explain(dir, 'aaa--x.json'), explain(dir, 'zzz--y.json')];
  assert.equal(got.filter(r => r === null).length, 1, `got ${got}`);
});

test('the copy whose text carries its own byline beats the lexically lower one', () => {
  const showId = 'jitney-2017';
  const { dir } = mkShow({
    'front-row-center--tulis-mccall.json': xo(showId, 'nytg--unknown.json', { criticName: 'Tulis McCall', fullText: `By Tulis McCall. ${BODY}` }),
    'nytg--unknown.json': xo(showId, 'front-row-center--tulis-mccall.json', { criticName: 'Unknown' }),
  }, showId);
  // 'front-row-center' < 'nytg' anyway; flip the names so the byline is what decides.
  const { dir: dir2 } = mkShow({
    'zz--tulis-mccall.json': xo(showId, 'aa--unknown.json', { criticName: 'Tulis McCall', fullText: `By Tulis McCall. ${BODY}` }),
    'aa--unknown.json': xo(showId, 'zz--tulis-mccall.json', { criticName: 'Unknown' }),
  }, showId);
  assert.equal(explain(dir, 'front-row-center--tulis-mccall.json'), null);
  assert.equal(explain(dir, 'nytg--unknown.json'), 'crossOutletDuplicate');
  assert.equal(explain(dir2, 'zz--tulis-mccall.json'), null);
  assert.equal(explain(dir2, 'aa--unknown.json'), 'crossOutletDuplicate');
});

test('a copy excluded for another reason loses, so the review still counts once', () => {
  const showId = 'some-show-2016';
  const { dir } = mkShow({
    'aaa--x.json': xo(showId, 'zzz--y.json', { wrongShow: true }),
    'zzz--y.json': xo(showId, 'aaa--x.json'),
  }, showId);
  assert.equal(explain(dir, 'aaa--x.json'), 'wrongShow');
  assert.equal(explain(dir, 'zzz--y.json'), null);
});

test('one-way flags and calls without filePath keep the flat exclusion', () => {
  const showId = 'some-show-2016';
  const { dir } = mkShow({
    'copy--x.json': xo(showId, 'primary--y.json'),
    'primary--y.json': row({}),
  }, showId);
  assert.equal(explain(dir, 'copy--x.json'), 'crossOutletDuplicate');
  assert.equal(explain(dir, 'primary--y.json'), null);
  assert.equal(explainExclusion(xo(showId, 'primary--y.json'), null, undefined), 'crossOutletDuplicate');
});

test('keeper choice is symmetric', () => {
  const a = { file: 'b--x.json', data: row({ criticName: 'Unknown' }) };
  const b = { file: 'a--y.json', data: row({ criticName: 'Unknown' }) };
  assert.equal(cycle.crossOutletCycleKeeper(a, b), cycle.crossOutletCycleKeeper(b, a));
  assert.equal(cycle.crossOutletCycleKeeper({ ...a, excludedOtherwise: true }, b), 'a--y.json');
  assert.equal(cycle.crossOutletCycleKeeper({ ...a, excludedOtherwise: true }, { ...b, excludedOtherwise: true }), 'a--y.json');
});

test('detector guard: flagging a secondary whose primary already points back would close a cycle', () => {
  assert.equal(cycle.wouldCloseCrossOutletCycle(xo('s', 'b.json'), 's', 'b.json'), true);
  assert.equal(cycle.wouldCloseCrossOutletCycle(row({ crossOutletDuplicate: true, crossOutletPrimaryFile: 'b.json' }), 's', 'b.json'), true);
  assert.equal(cycle.wouldCloseCrossOutletCycle(xo('s', 'c.json'), 's', 'b.json'), false);
  assert.equal(cycle.wouldCloseCrossOutletCycle(xo('other', 'b.json'), 's', 'b.json'), false);
  assert.equal(cycle.wouldCloseCrossOutletCycle({ crossOutletDuplicate: false, crossOutletPrimaryFile: 's/b.json' }, 's', 'b.json'), false);
  assert.equal(cycle.wouldCloseCrossOutletCycle(null, 's', 'b.json'), false);
});

test('audit reports a mutual cycle report-only (no --fix action, gate unaffected)', () => {
  const showId = 'some-show-2016';
  const { root } = mkShow({
    'aaa--x.json': xo(showId, 'zzz--y.json'),
    'zzz--y.json': xo(showId, 'aaa--x.json'),
  }, showId);
  const env = { ...process.env, REVIEW_TEXTS_DIR: root };
  const res = spawnSync('node', [AUDIT, '--json'], { env, encoding: 'utf8' });
  const out = JSON.parse(res.stdout);
  const hits = out.mismatches.filter(m => m.reason === 'crossOutlet-cycle');
  assert.deepEqual(hits.map(m => m.file).sort(), ['aaa--x.json', 'zzz--y.json']);
  assert.ok(hits.every(m => m.field === 'crossOutletDuplicate' && !m.action));
  // --fix leaves both flags untouched.
  spawnSync('node', [AUDIT, '--fix'], { env, encoding: 'utf8' });
  for (const f of ['aaa--x.json', 'zzz--y.json']) {
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, showId, f), 'utf8')).crossOutletDuplicate, true);
  }
});
