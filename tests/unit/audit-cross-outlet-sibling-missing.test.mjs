// TESTS-VS-DERIVED-DATA-EXEMPT: fixture-based test of the audit script; isolated tmp dir, no production data files.
/**
 * BRO-3872: audit-duplicate-of-url-mismatch.js must catch crossOutletDuplicate
 * flags whose crossOutletPrimaryFile was deleted outside the cascade-clear call
 * sites, heal them via --fix without touching duplicateOf, and keep them out of
 * the duplicateOf --gate floor / --fix surge guard (37-file backlog pre-exists).
 *
 * Run: node --test tests/unit/audit-cross-outlet-sibling-missing.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const SCRIPT = path.join(import.meta.dirname, '..', '..', 'scripts', 'audit-duplicate-of-url-mismatch.js');

function mkFixture(shows) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xo-audit-'));
  for (const [showId, files] of Object.entries(shows)) {
    fs.mkdirSync(path.join(root, showId), { recursive: true });
    for (const [name, obj] of Object.entries(files)) {
      fs.writeFileSync(path.join(root, showId, name), JSON.stringify(obj, null, 2) + '\n');
    }
  }
  return root;
}
const read = (root, s, f) => JSON.parse(fs.readFileSync(path.join(root, s, f), 'utf8'));
const run = (root, ...args) => spawnSync('node', [SCRIPT, ...args], { env: { ...process.env, REVIEW_TEXTS_DIR: root }, encoding: 'utf8' });
let n = 0;
// unique URL per fixture so no file is mistaken for a renamed-primary twin of another
const xo = (primary, extra = {}) => ({ url: `https://a.com/${++n}`, crossOutletDuplicate: true, crossOutletPrimaryFile: primary, crossOutletSimilarity: 0.9, crossOutletMethod: 'fp', crossOutletFlaggedAt: 't', ...extra });
const load = (root) => {
  // REVIEW_TEXTS_DIR is read at module load: use a fresh copy per fixture.
  const p = require.resolve(SCRIPT);
  delete require.cache[p];
  process.env.REVIEW_TEXTS_DIR = root;
  return require(SCRIPT);
};

test('dangling crossOutletPrimaryFile is flagged; live primary and cross-dir live primary are not', () => {
  const root = mkFixture({
    s1: { 'a--x.json': xo('s1/gone.json'), 'b--y.json': xo('s1/live.json'), 'live.json': { url: 'https://l.com/1' }, 'c--z.json': xo('s2/live2.json') },
    s2: { 'live2.json': { url: 'https://l.com/2' } },
  });
  const { audit } = load(root);
  const m = audit().mismatches.filter(x => x.field === 'crossOutletDuplicate');
  assert.deepEqual(m.map(x => [x.file, x.reason]), [['a--x.json', 'sibling-missing']]);
});

test('cross-dir primary that is missing, self-pointer, and missing pointer are flagged', () => {
  const root = mkFixture({
    s1: { 'a.json': xo('s2/nope.json'), 'self.json': xo('s1/self.json'), 'np.json': { url: 'u', crossOutletDuplicate: true } },
    s2: { 'other.json': { url: 'u2' } },
  });
  const { audit } = load(root);
  const m = Object.fromEntries(audit().mismatches.map(x => [x.file, x.reason]));
  assert.deepEqual(m, { 'a.json': 'sibling-missing', 'self.json': 'self-reference', 'np.json': 'pointer-missing' });
});

test('renamed primary (same-URL twin or same critic under another outlet) is report-only and --fix leaves it flagged', () => {
  const root = mkFixture({
    s1: {
      'amny--matt-windman.json': xo('s1/newsday--linda-winer.json', { url: 'https://amny.com/a' }),
      'newsday--matt-windman.json': { url: 'https://newsday.com/b' },
      'x--unknown.json': xo('s1/gone.json', { url: 'https://same.com/p' }),
      'y--unknown.json': { url: 'https://same.com/p' },
      'self.json': xo('s1/self.json'),
    },
  });
  const { audit } = load(root);
  const m = Object.fromEntries(audit().mismatches.map(x => [x.file, x.reason]));
  assert.equal(m['amny--matt-windman.json'], 'primary-renamed');
  assert.equal(m['x--unknown.json'], 'primary-renamed');
  assert.equal(m['self.json'], 'self-reference');
  assert.equal(run(root, '--fix').status, 0);
  for (const f of ['amny--matt-windman.json', 'x--unknown.json', 'self.json']) assert.equal(read(root, 's1', f).crossOutletDuplicate, true, f);
});

test('--fix clears crossOutlet fields, leaves duplicateTextOf untouched, skips pointer-missing', () => {
  const root = mkFixture({
    s1: {
      'a.json': xo('s1/gone.json', { duplicateTextOf: 'keep.json' }),
      'keep.json': { url: 'https://k.com/keep' },
      'np.json': { url: 'u', crossOutletDuplicate: true },
    },
  });
  const r = run(root, '--fix');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const a = read(root, 's1', 'a.json');
  assert.equal(a.crossOutletDuplicate, false);
  assert.match(a.crossOutletClearReason, /gone\.json no longer exists/);
  for (const k of ['crossOutletPrimaryFile', 'crossOutletSimilarity', 'crossOutletMethod', 'crossOutletFlaggedAt']) assert.equal(k in a, false, k);
  assert.equal(a.duplicateTextOf, 'keep.json');
  assert.ok(!a.duplicateClearReason, 'must not stamp duplicateClearReason');
  assert.equal(read(root, 's1', 'np.json').crossOutletDuplicate, true);
  assert.equal(run(root).stdout.includes('s1/a.json'), false);
});

test('surge: >25 crossOutlet clears are skipped (exit 0) without --force-bulk, applied with it; never trip --gate', () => {
  const files = {};
  for (let i = 0; i < 26; i++) files[`f${i}.json`] = xo(`s1/gone${i}.json`);
  const root = mkFixture({ s1: files });
  const g = run(root, '--gate');
  assert.equal(g.status, 0, g.stdout + g.stderr);
  const r = run(root, '--fix');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /::warning::Skipping 26 crossOutletDuplicate/);
  assert.equal(read(root, 's1', 'f0.json').crossOutletDuplicate, true);
  const b = run(root, '--fix', '--force-bulk');
  assert.equal(b.status, 0);
  assert.equal(read(root, 's1', 'f0.json').crossOutletDuplicate, false);
});

test('clearCrossOutletFields is shared with cascade-clear (same output)', () => {
  const { clearCrossOutletFields } = require('../../scripts/lib/cascade-clear-duplicate-refs.js');
  const d = clearCrossOutletFields({ duplicateOf: 'x.json', ...xo('s/p.json') }, 'why');
  assert.equal(d.duplicateOf, 'x.json');
  assert.equal(d.crossOutletClearReason, 'why');
  assert.equal(d.crossOutletDuplicate, false);
});
