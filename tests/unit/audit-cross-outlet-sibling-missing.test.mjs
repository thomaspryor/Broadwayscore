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

const live = (url, extra = {}) => ({ url, fullText: 'x'.repeat(3000), assignedScore: 70, criticName: 'Some Critic', publishDate: '2020-01-01', ...extra });

test('renamed primary with a LIVE twin is repointed (stays excluded); a dead twin stays report-only', () => {
  const root = mkFixture({
    s1: {
      'amny--matt-windman.json': xo('s1/newsday--linda-winer.json', { url: 'https://amny.com/a' }),
      'newsday--matt-windman.json': live('https://newsday.com/b'),
      'x--unknown.json': xo('s1/gone.json', { url: 'https://same.com/p' }),
      'y--unknown.json': live('https://same.com/p'),
      'd--unknown.json': xo('s1/gone2.json', { url: 'https://dead.com/p' }),
      'e--unknown.json': { url: 'https://dead.com/p', wrongProduction: true },
    },
  });
  const { audit } = load(root);
  const m = Object.fromEntries(audit().mismatches.map(x => [x.file, [x.reason, x.action || null]]));
  assert.deepEqual(m['amny--matt-windman.json'], ['primary-renamed', 'repoint']);
  assert.deepEqual(m['x--unknown.json'], ['primary-renamed', 'repoint']);
  assert.deepEqual(m['d--unknown.json'], ['primary-renamed', null]);
  assert.equal(run(root, '--fix').status, 0);
  const a = read(root, 's1', 'amny--matt-windman.json');
  assert.equal(a.crossOutletDuplicate, true);
  assert.equal(a.crossOutletPrimaryFile, 's1/newsday--matt-windman.json');
  assert.match(a.crossOutletRepointReason, /newsday--linda-winer\.json no longer exists/);
  assert.equal(read(root, 's1', 'x--unknown.json').crossOutletPrimaryFile, 's1/y--unknown.json');
  assert.equal(read(root, 's1', 'd--unknown.json').crossOutletPrimaryFile, 's1/gone2.json');
  // repointed refs are no longer dangling
  const after = load(root).audit().mismatches.map(x => x.file);
  assert.deepEqual(after, ['d--unknown.json']);
});

test('BRO-3870: renamed primary whose twin points back at us is cleared (the pair excluded each other)', () => {
  const root = mkFixture({
    s1: {
      'nytimes--ben-brantley.json': xo('s1/about--unknown.json', { url: 'https://www.nytimes.com/r' }),
      'nytimes--unknown.json': xo('s1/nytimes--ben-brantley.json', { url: 'http://theater.nytimes.com/r' }),
    },
  });
  const r = run(root, '--fix');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const a = read(root, 's1', 'nytimes--ben-brantley.json');
  assert.equal(a.crossOutletDuplicate, false);
  assert.match(a.crossOutletClearReason, /names this file as its primary/);
  assert.equal(read(root, 's1', 'nytimes--unknown.json').crossOutletDuplicate, true, 'twin stays the duplicate');
  assert.equal(load(root).audit().mismatches.length, 0);
});

test('self-reference with no other copy is cleared; with a same-URL copy it stays report-only', () => {
  const root = mkFixture({
    s1: {
      'self.json': xo('s1/self.json'),
      'self2.json': xo('s1/self2.json', { url: 'https://dup.com/1' }),
      'other.json': live('https://dup.com/1'),
    },
  });
  assert.equal(run(root, '--fix').status, 0);
  assert.equal(read(root, 's1', 'self.json').crossOutletDuplicate, false);
  assert.match(read(root, 's1', 'self.json').crossOutletClearReason, /pointed at this file itself/);
  assert.equal(read(root, 's1', 'self2.json').crossOutletDuplicate, true);
});

test('crossOutletRenamedAction: a live twin wins over one that defers; pointers must name this exact show/file', async () => {
  const { crossOutletRenamedAction } = load(mkFixture({ s1: {} }));
  const defers = { showId: 's', data: { crossOutletDuplicate: true, crossOutletPrimaryFile: 's/a.json' }, live: false };
  const live = { showId: 's', data: {}, live: true };
  assert.equal(crossOutletRenamedAction('s', 'a.json', [defers]).action, 'clear');
  assert.equal(crossOutletRenamedAction('s', 'a.json', [defers, live]).action, 'repoint', 'a live copy blocks the clear (no double count)');
  assert.equal(crossOutletRenamedAction('s', 'a.json', [defers, live]).twin, live);
  // same file name in ANOTHER show dir is not us
  assert.equal(crossOutletRenamedAction('s', 'a.json', [{ showId: 't', data: { crossOutletDuplicate: true, crossOutletPrimaryFile: 'a.json' }, live: false }]).action, null);
  assert.equal(crossOutletRenamedAction('s', 'a.json', [{ showId: 's', data: { crossOutletDuplicate: true, crossOutletPrimaryFile: 's/c.json' }, live: false }]).action, null);
  assert.equal(crossOutletRenamedAction('s', 'a.json', [{ showId: 's', data: {}, live: false }]).action, null);
  assert.equal(crossOutletRenamedAction('s', 'a.json', []).action, null);
});

test('ship-check: C defers to A but A\'s renamed primary B is live: A is repointed to B, not cleared', () => {
  const root = mkFixture({
    s1: {
      'a--x.json': xo('s1/gone.json', { url: 'https://p.com/1' }),
      // C sorts before B and points back at A
      'b0--c.json': xo('s1/a--x.json', { url: 'https://p.com/1' }),
      'b1--live.json': live('https://p.com/1'),
    },
  });
  assert.equal(run(root, '--fix').status, 0);
  const a = read(root, 's1', 'a--x.json');
  assert.equal(a.crossOutletDuplicate, true, 'A stays excluded: B already scores the article');
  assert.equal(a.crossOutletPrimaryFile, 's1/b1--live.json');
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
