import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// The real CLI guard lives at scripts/check-orphan-commits.js — require it so a
// change to its detection logic breaks this test (CLAUDE.md §15).
const { findOrphanCommits, resolveRange, parseArgs } = require('../check-orphan-commits.js');

test('flags a commit line with no parents (a root/orphan commit)', () => {
  // `git rev-list --parents` output: "<commit> [<parent>...]".
  const out = [
    'aaaa1111 bbbb2222', // normal: one parent
    'cccc3333', // ORPHAN: no parents
    'dddd4444 eeee5555 ffff6666', // merge: two parents
  ].join('\n');
  assert.deepEqual(findOrphanCommits(out), ['cccc3333']);
});

test('reproduces the #209 shape: a parentless full-tree root inside the range', () => {
  // The real incident: 53ff06a4a7a had an empty parent list.
  const out = '53ff06a4a7a201714776964fdb7ce68563fa49b4';
  assert.deepEqual(findOrphanCommits(out), ['53ff06a4a7a201714776964fdb7ce68563fa49b4']);
});

test('a clean range (every commit parented) yields no orphans', () => {
  const out = ['1111 0000', '2222 1111', '3333 2222 aaaa'].join('\n');
  assert.deepEqual(findOrphanCommits(out), []);
});

test('finds multiple orphans and preserves git order', () => {
  const out = ['aaaa', 'bbbb cccc', 'dddd'].join('\n');
  assert.deepEqual(findOrphanCommits(out), ['aaaa', 'dddd']);
});

test('empty / whitespace-only output is clean', () => {
  assert.deepEqual(findOrphanCommits(''), []);
  assert.deepEqual(findOrphanCommits('\n  \n'), []);
});

test('tolerates blank lines and extra whitespace between fields', () => {
  const out = '  aaaa   bbbb  \n\n   cccc   \n';
  assert.deepEqual(findOrphanCommits(out), ['cccc']);
});

test('resolveRange parses --range=BASE..HEAD', () => {
  assert.deepEqual(resolveRange({ range: 'origin/main..HEAD' }), {
    base: 'origin/main',
    head: 'HEAD',
  });
});

test('resolveRange defaults head to HEAD when only base given', () => {
  assert.deepEqual(resolveRange({ base: 'origin/main' }), { base: 'origin/main', head: 'HEAD' });
});

test('resolveRange maps GitHub before/after payload', () => {
  assert.deepEqual(resolveRange({ before: 'abc', after: 'def' }), { base: 'abc', head: 'def' });
});

test('resolveRange returns null when no base resolvable', () => {
  assert.equal(resolveRange({}), null);
  assert.equal(resolveRange({ head: 'HEAD' }), null);
});

test('parseArgs handles --k=v and bare flags', () => {
  const a = parseArgs(['--range=a..b', '--verbose']);
  assert.equal(a.range, 'a..b');
  assert.equal(a.verbose, true);
});
