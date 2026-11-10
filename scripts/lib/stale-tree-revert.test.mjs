// BRO-7078: a commit built from a stale checkout puts back older file versions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { classifyCommit, isIntentionalRevert, scanRange } = require('./stale-tree-revert.js');

const f = (p, newBlob, parentBlob, history) => ({ path: p, newBlob, parentBlob, history });

test('a commit that restores 3+ earlier blobs is flagged', () => {
  const r = classifyCommit({ subject: 'BRO-1: fixups', files: [
    f('a.js', 'old-a', 'cur-a', ['prev-a', 'old-a']),
    f('b.js', 'old-b', 'cur-b', ['old-b']),
    f('c.json', 'old-c', 'cur-c', ['x', 'y', 'old-c']),
    f('d.js', 'new-d', 'cur-d', ['old-d']),
  ] });
  assert.deepEqual(r.restored, ['a.js', 'b.js', 'c.json']);
  assert.equal(r.flagged, true);
});

test('ordinary edits (new blobs) are never flagged', () => {
  const r = classifyCommit({ subject: 'feat: x', files: [
    f('a.js', 'n1', 'c1', ['o1']), f('b.js', 'n2', 'c2', ['o2']), f('c.js', 'n3', 'c3', []),
  ] });
  assert.equal(r.restored.length, 0);
  assert.equal(r.flagged, false);
});

test('below the threshold is reported but not flagged (a toggled ledger file)', () => {
  const r = classifyCommit({ subject: 'data: ledger', files: [f('l.json', 'o', 'c', ['o'])] });
  assert.equal(r.restored.length, 1);
  assert.equal(r.flagged, false);
});

test('an intentional git revert is exempt', () => {
  assert.equal(isIntentionalRevert('Revert "feat: x"'), true);
  assert.equal(isIntentionalRevert('fix: revert-safe parser'), false);
  const files = ['a', 'b', 'c'].map((p) => f(p, `o${p}`, `c${p}`, [`o${p}`]));
  assert.equal(classifyCommit({ subject: 'Revert "BRO-9"', files }).flagged, false);
});

test('scanRange flags a real stale-tree commit and passes a normal one (temp git repo)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-tree-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  const write = (o) => { for (const [k, v] of Object.entries(o)) fs.writeFileSync(path.join(dir, k), v); g('add', '-A'); };
  write({ 'a.js': 'a1', 'b.js': 'b1', 'c.js': 'c1' }); g('commit', '-qm', 'v1');
  write({ 'a.js': 'a2', 'b.js': 'b2', 'c.js': 'c2' }); g('commit', '-qm', 'others land v2');
  const base = g('rev-parse', 'HEAD');
  // normal edit on top of v2
  write({ 'a.js': 'a3' }); g('commit', '-qm', 'normal edit');
  // stale tree: rewrites every file back to v1 plus its own tiny change
  write({ 'a.js': 'a1', 'b.js': 'b1', 'c.js': 'c1' }); g('commit', '-qm', 'BRO-1: fixups');
  const prev = process.cwd();
  process.chdir(dir);
  try {
    const res = scanRange({ base });
    assert.equal(res.length, 2);
    assert.equal(res[0].flagged, false, 'normal edit must pass');
    assert.equal(res[1].flagged, true, 'stale-tree commit must be flagged');
    assert.deepEqual(res[1].restored.sort(), ['a.js', 'b.js', 'c.js']);
  } finally {
    process.chdir(prev);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
