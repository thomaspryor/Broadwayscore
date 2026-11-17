import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const { restoreAll } = createRequire(import.meta.url)('./restore-prebuild-residue.js');

function repo() {
  const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'rpr-'));
  const g = (...a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.mkdirSync(path.join(d, 'data')); fs.writeFileSync(path.join(d, 'data/gold-lists-computed.json'), '{"a":1}');
  fs.writeFileSync(path.join(d, 'keep.txt'), 'x'); g('add', '.'); g('commit', '-qm', 'i');
  return d;
}

test('leftover gold-lists output is restored; other edits are left alone', () => {
  const d = repo();
  try {
    fs.writeFileSync(path.join(d, 'data/gold-lists-computed.json'), '{"a":2}');
    fs.writeFileSync(path.join(d, 'keep.txt'), 'edited');
    const r = restoreAll([d], { live: () => false });
    assert.deepEqual(r.restored[d], ['data/gold-lists-computed.json']);
    assert.equal(fs.readFileSync(path.join(d, 'data/gold-lists-computed.json'), 'utf8'), '{"a":1}');
    assert.equal(fs.readFileSync(path.join(d, 'keep.txt'), 'utf8'), 'edited');
  } finally { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('nothing is touched while a land check is running; non-repos are ignored', () => {
  const d = repo();
  try {
    fs.writeFileSync(path.join(d, 'data/gold-lists-computed.json'), '{"a":2}');
    assert.ok(restoreAll([d], { live: () => true }).skipped);
    assert.equal(fs.readFileSync(path.join(d, 'data/gold-lists-computed.json'), 'utf8'), '{"a":2}');
    assert.deepEqual(restoreAll(['/nonexistent-x'], { live: () => false }).restored, {});
  } finally { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
