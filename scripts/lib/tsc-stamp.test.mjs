/**
 * tsc-stamp.test.mjs — BRO-5783. Drives the REAL decide()/computeKey()/CLI.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { decide, computeKey } = require('./tsc-stamp.js');
const SCRIPT = path.resolve(import.meta.dirname, 'tsc-stamp.js');

const H = 'a'.repeat(40);
const K = 'b'.repeat(64);
const ok = { env: { GITHUB_ACTIONS: 'true', LAND_TSC_STAMP_FILE: '/x' }, headOid: H, pushedOid: H, specCount: 1, remoteRef: 'refs/heads/main', key: K, stampLines: [K] };

test('skips only on the full happy path', () => {
  assert.equal(decide(ok).skip, true);
});

for (const [name, patch] of [
  ['outside CI', { env: { LAND_TSC_STAMP_FILE: '/x' } }],
  ['no stamp file var', { env: { GITHUB_ACTIONS: 'true' } }],
  ['two specs', { specCount: 2 }],
  ['not main', { remoteRef: 'refs/heads/land/x' }],
  ['pushed oid is not HEAD', { pushedOid: 'c'.repeat(40) }],
  ['zero oid', { headOid: '0'.repeat(40), pushedOid: '0'.repeat(40) }],
  ['malformed key', { key: 'abc', stampLines: ['abc'] }],
  ['key not stamped', { stampLines: [] }],
  ['prefix of key is not a match', { stampLines: [K.slice(0, 12)] }],
]) {
  test(`runs tsc: ${name}`, () => assert.equal(decide({ ...ok, ...patch }).skip, false));
}

function mkRepo(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tscstamp-'));
  const g = (...a) => execFileSync('git', a, { cwd: d, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  const commit = (f) => {
    for (const [k, v] of Object.entries(f)) { fs.mkdirSync(path.dirname(path.join(d, k)), { recursive: true }); fs.writeFileSync(path.join(d, k), v); }
    g('add', '-A'); g('commit', '-q', '-m', 'c'); return g('rev-parse', 'HEAD');
  };
  return { d, g, commit, key: (sha) => computeKey(sha, { cwd: d }) };
}

test('key is stable across inert churn, changes on code or data/*.json', () => {
  const r = mkRepo({});
  const base = r.commit({ 'src/a.ts': 'export const a = 1;\n', 'data/shows.json': '[]', 'data/audit/x.json': '1' });
  const inert = r.commit({ 'data/audit/x.json': '2', 'data/collection-state/y.json': '1' });
  assert.equal(r.key(inert), r.key(base), 'inert-only churn must not change the key');
  const json = r.commit({ 'data/shows.json': '[1]' });
  assert.notEqual(r.key(json), r.key(inert), 'a top-level data JSON reshape must change the key');
  const code = r.commit({ 'src/a.ts': 'export const a = 2;\n' });
  assert.notEqual(r.key(code), r.key(json), 'a code change must change the key');
});

test('CLI: record then check skips; fails open outside CI and on a different tree', () => {
  const r = mkRepo({});
  const c1 = r.commit({ 'src/a.ts': 'x\n', 'data/shows.json': '[]' });
  const stamp = path.join(r.d, 'stamp');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', LAND_TSC_STAMP_FILE: stamp };
  const run = (cmd, e = env, extra = [`--pushed-oid=${r.g('rev-parse', 'HEAD')}`, '--spec-count=1', '--remote-ref=refs/heads/main']) =>
    spawnSync('node', [SCRIPT, cmd, ...extra], { cwd: r.d, env: e, encoding: 'utf8' });
  assert.equal(run('check').status, 1, 'no stamp yet -> run tsc');
  assert.equal(run('record').status, 0);
  assert.match(fs.readFileSync(stamp, 'utf8'), /^[0-9a-f]{64}\n$/);
  assert.equal(run('check').status, 0, 'same tree -> skip');
  assert.equal(run('check', { ...env, GITHUB_ACTIONS: '' }).status, 1, 'outside CI -> run tsc');
  r.commit({ 'src/a.ts': 'y\n' });
  assert.equal(run('check', env, [`--pushed-oid=${r.g('rev-parse', 'HEAD')}`, '--spec-count=1', '--remote-ref=refs/heads/main']).status, 1, 'new code tree -> run tsc');
  assert.equal(run('check', env, [`--pushed-oid=${c1}`, '--spec-count=1', '--remote-ref=refs/heads/main']).status, 1, 'pushed oid != HEAD -> run tsc');
  fs.rmSync(r.d, { recursive: true, force: true });
});
