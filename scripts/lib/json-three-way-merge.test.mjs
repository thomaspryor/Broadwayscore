// BRO-4688: key-wise 3-way JSON merge used by push-with-retry.sh's autostash restore.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeJson } = require('./json-three-way-merge.js');
const CLI = path.join(path.dirname(new URL(import.meta.url).pathname), 'json-three-way-merge.js');

const base = { _meta: { lastUpdated: '2026-10-16T05:00:00.000Z' }, outlets: { nyt: { name: 'NYT', tier: 1 } } };

test('both sides add different outlets: both kept, later lastUpdated wins', () => {
  const ours = { _meta: { lastUpdated: '2026-10-16T06:00:00.000Z' }, outlets: { ...base.outlets, a: { name: 'A' } } };
  const theirs = { _meta: { lastUpdated: '2026-10-16T06:05:00.000Z' }, outlets: { ...base.outlets, b: { name: 'B' } } };
  const r = mergeJson(base, ours, theirs);
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.merged.outlets), ['nyt', 'b', 'a']);
  assert.equal(r.merged._meta.lastUpdated, '2026-10-16T06:05:00.000Z');
});

test('a stale snapshot never reverts an upstream edit of a shared entry', () => {
  const ours = { ...base, outlets: { ...base.outlets, a: { name: 'A' } } };
  const theirs = { ...base, outlets: { nyt: { name: 'NYT', tier: 2 } } };
  const r = mergeJson(base, ours, theirs);
  assert.equal(r.ok, true);
  assert.equal(r.merged.outlets.nyt.tier, 2);
  assert.ok(r.merged.outlets.a);
});

test('one-sided deletes apply; untouched keys survive', () => {
  const b = { q: [1], keep: 1, gone: 2 };
  assert.deepEqual(mergeJson(b, { q: [1], keep: 1 }, { q: [1, 2], keep: 1, gone: 2 }).merged, { q: [1, 2], keep: 1 });
});

test('the same value changed differently on both sides is a conflict', () => {
  const ours = { outlets: { nyt: { name: 'NYT', tier: 3 } } };
  const theirs = { outlets: { nyt: { name: 'NYT', tier: 2 } } };
  assert.equal(mergeJson(base, ours, theirs).ok, false);
});

test('arrays are atomic: both sides appending to the same array conflicts', () => {
  assert.equal(mergeJson([{ k: 'a' }], [{ k: 'a' }, { k: 'c' }], [{ k: 'a' }, { k: 'b' }]).ok, false);
  assert.equal(mergeJson({ q: [1] }, { q: [1, 3] }, { q: [1, 2] }).ok, false);
});

test('non-timestamp strings changed on both sides conflict', () => {
  assert.equal(mergeJson({ s: 'x' }, { s: 'y' }, { s: 'z' }).ok, false);
});

test('CLI writes theirs layout and exits 0; exits 1 on conflict without writing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'j3w-'));
  const w = (n, v, indent, nl) => { fs.writeFileSync(path.join(dir, n), JSON.stringify(v, null, indent) + (nl ? '\n' : '')); return path.join(dir, n); };
  const out = path.join(dir, 'out');
  execFileSync('node', [CLI, w('b', { a: 1 }, 2, false), w('o', { a: 1, o: 1 }, 2, false), w('t', { a: 1, t: 1 }, 4, true), out]);
  assert.equal(fs.readFileSync(out, 'utf8'), JSON.stringify({ a: 1, t: 1, o: 1 }, null, 4) + '\n');
  const out2 = path.join(dir, 'out2');
  assert.throws(() => execFileSync('node', [CLI, w('b2', { a: 1 }), w('o2', { a: 2 }), w('t2', { a: 3 }), out2], { stdio: 'ignore' }));
  assert.equal(fs.existsSync(out2), false);
  // no base file: both-added keys still merge
  execFileSync('node', [CLI, path.join(dir, 'missing'), w('o3', { o: 1 }, 2, true), w('t3', { t: 1 }, 2, true), out]);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), { t: 1, o: 1 });
});

test('CLI refuses files that would not round-trip byte-identically', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'j3w-'));
  const w = (n, text) => { fs.writeFileSync(path.join(dir, n), text); return path.join(dir, n); };
  const out = path.join(dir, 'out');
  const b = w('b', '{\n  "a": 1\n}\n');
  const o = w('o', '{\n  "a": 1,\n  "o": 1\n}\n');
  for (const t of ['{\r\n  "a": 1,\r\n  "t": 1\r\n}\r\n', '{\n  "a": 1, "t": 1\n}\n', '{\n  "a": 1,\n  "t": 12345678901234567890\n}\n']) {
    assert.throws(() => execFileSync('node', [CLI, b, o, w('t', t), out], { stdio: 'ignore' }));
    assert.equal(fs.existsSync(out), false);
  }
});

test('a literal __proto__ key survives as a key', () => {
  const r = mergeJson({}, JSON.parse('{"__proto__": {"x": 1}}'), { t: 1 });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.merged), ['t', '__proto__']);
  assert.equal(JSON.stringify(r.merged), '{"t":1,"__proto__":{"x":1}}');
});
