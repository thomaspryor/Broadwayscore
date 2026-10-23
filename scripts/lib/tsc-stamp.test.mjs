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
  fs.rmSync(r.d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('key covers nested data JSON that src/ imports, ignores other nested data JSON', () => {
  const r = mkRepo({});
  const a = r.commit({ 'src/a.ts': "import g from '../data/analysis/gd.json';\n", 'data/analysis/gd.json': '{}', 'data/audit/x.json': '1' });
  const audit = r.commit({ 'data/audit/x.json': '2' });
  assert.equal(r.key(audit), r.key(a), 'unreferenced nested data json is inert');
  const gd = r.commit({ 'data/analysis/gd.json': '{"a":1}' });
  assert.notEqual(r.key(gd), r.key(audit), 'a src-imported nested data json must change the key');
});

test('CLI: a dirty tracked tree neither records nor skips', () => {
  const r = mkRepo({});
  r.commit({ 'src/a.ts': 'x\n' });
  const stamp = path.join(r.d, 'stamp');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', LAND_TSC_STAMP_FILE: stamp };
  const args = [`--pushed-oid=${r.g('rev-parse', 'HEAD')}`, '--spec-count=1', '--remote-ref=refs/heads/main'];
  const run = (cmd) => spawnSync('node', [SCRIPT, cmd, ...args], { cwd: r.d, env, encoding: 'utf8' });
  assert.equal(run('record').status, 0);
  assert.equal(run('check').status, 0, 'clean tree after record -> skip');
  fs.writeFileSync(path.join(r.d, 'src/a.ts'), 'dirty\n');
  assert.equal(run('check').status, 1, 'dirty tree -> run tsc');
  fs.rmSync(stamp);
  assert.equal(run('record').status, 0);
  assert.equal(fs.existsSync(stamp), false, 'dirty tree must not be stamped');
  fs.rmSync(r.d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('land.yml kill-switch expression yields the path unless disabled', () => {
  const y = fs.readFileSync(path.resolve(import.meta.dirname, '../../.github/workflows/land.yml'), 'utf8');
  const m = /LAND_TSC_STAMP_FILE: \$\{\{ (.+?) \}\}/.exec(y);
  assert.ok(m, 'LAND_TSC_STAMP_FILE env present');
  // `cond && VALUE || ''`: VALUE must be the truthy (non-empty) branch, so '' is only reachable when disabled.
  assert.match(m[1], /^vars\.LAND_TSC_STAMP_DISABLED != '1' && format\([^)]*\) \|\| ''$/);
});

// ── BRO-6043: seeding the Land job's stamp from the checks job ──────────────
const { decideSeedExport, decideSeed, dataDigest } = require('./tsc-stamp.js');
const R = 'd'.repeat(40);
const D = 'e'.repeat(64);
const exp = { meta: { sha: R, exits: { tsc: 0, 'tsc-llm-scoring': 0 } }, rebased: R, headOid: R, residue: [], key: K, digest: D, preDigest: D };

test('seed-export tolerates the gold-lists prep residue (the only inert one)', () => {
  assert.equal(decideSeedExport({ ...exp, residue: ['data/gold-lists-computed.json'] }).seed, `${K}:${D}`);
});

test('inert-residue premise: the only src importer of gold-lists-computed.json casts through unknown', () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const hits = execFileSync('git', ['grep', '-l', 'gold-lists-computed', '--', 'src', '*.ts', '*.tsx'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
    .filter((f) => /^[^/]*\.tsx?$|^src\//.test(f) && !f.startsWith('scripts/'));
  for (const f of hits) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    if (!/import\s+\w+\s+from\s+['"][^'"]*gold-lists-computed\.json['"]/.test(text)) continue; // mention only
    assert.equal(f, 'src/lib/data-gold-list-badges.ts', `${f} imports gold-lists-computed.json: tsc may now depend on its content; drop it from TSC_INERT_RESIDUE`);
    assert.match(text, /computedData as unknown as /);
  }
  assert.ok(require('./tsc-stamp.js').TSC_INERT_RESIDUE.has('data/gold-lists-computed.json'));
});

test('seed-export: exports key:digest only for tsc exit 0 on the rebased sha', () => {
  assert.equal(decideSeedExport(exp).seed, `${K}:${D}`);
});
for (const [name, patch] of [
  ['no meta', { meta: null }],
  ['meta measured another sha', { meta: { sha: 'f'.repeat(40), exits: { tsc: 0 } } }],
  ['HEAD moved off the rebased sha', { headOid: 'f'.repeat(40) }],
  ['tsc red (forgiven by a red base)', { meta: { sha: R, exits: { tsc: 1 } } }],
  ['tsc gate absent from the run', { meta: { sha: R, exits: { 'next-lint': 0 } } }],
  ['tsc saw tracked residue in src', { residue: ['src/x.ts'] }],
  ['no tsc-time tree status', { residue: null }],
  ['bad key', { key: 'abc' }],
  ['no pre-gauntlet digest', { preDigest: '' }],
  ['core data changed during the gauntlet', { preDigest: '0'.repeat(64) }],
]) {
  test(`seed-export refuses: ${name}`, () => assert.equal(decideSeedExport({ ...exp, ...patch }).seed, ''));
}

const sd = { env: { GITHUB_ACTIONS: 'true', LAND_TSC_STAMP_FILE: '/x' }, seed: `${K}:${D}`, digest: D };
test('seed: appends the key when the core-data digest matches', () => assert.equal(decideSeed(sd).key, K));
for (const [name, patch] of [
  ['outside CI', { env: { LAND_TSC_STAMP_FILE: '/x' } }],
  ['kill switch (empty stamp file)', { env: { GITHUB_ACTIONS: 'true', LAND_TSC_STAMP_FILE: '' } }],
  ['no seed', { seed: '' }],
  ['malformed seed', { seed: K }],
  ['core data drifted between jobs', { digest: '0'.repeat(64) }],
]) {
  test(`seed refuses: ${name}`, () => assert.equal(decideSeed({ ...sd, ...patch }).key, ''));
}

test('seed end-to-end: exported seed makes the first check() in another job skip; drifted data does not', () => {
  const r = mkRepo({});
  const head = r.commit({ 'src/a.ts': 'export const a = 1;\n', 'data/shows.json': '[]\n', '.gitignore': 'data/core.json\n' });
  const d = r.d;
  fs.writeFileSync(path.join(d, 'data', 'core.json'), '{"v":1}\n');
  const metaFile = path.join(d, 'meta.json');
  fs.writeFileSync(metaFile, JSON.stringify({ sha: head, exits: { tsc: 0 } }));
  const cli = (args, env = {}) => spawnSync('node', [SCRIPT, ...args], { cwd: d, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true', ...env } });
  const preFile = path.join(d, 'pre');
  const okTs = path.join(d, 'ts-ok');
  fs.writeFileSync(okTs, ' M data/gold-lists-computed.json\n');
  cli(['digest-pre', `--out=${preFile}`]);
  const exported = cli(['seed-export', `--meta=${metaFile}`, `--rebased=${head}`, `--pre=${preFile}`, `--tree-status=${okTs}`]);
  const seed = exported.stdout.trim();
  assert.match(seed, /^[0-9a-f]{64}:[0-9a-f]{64}$/);
  const stamp = path.join(d, 'stamp');
  const push = ['check', `--pushed-oid=${head}`, '--spec-count=1', '--remote-ref=refs/heads/main'];
  assert.equal(cli(push, { LAND_TSC_STAMP_FILE: stamp }).status, 1, 'unseeded: tsc runs');
  cli(['seed', `--seed=${seed}`], { LAND_TSC_STAMP_FILE: stamp });
  assert.equal(cli(push, { LAND_TSC_STAMP_FILE: stamp }).status, 0, 'seeded: tsc skipped');
  // core data differs in the Land job => not seeded
  const stamp2 = path.join(d, 'stamp2');
  fs.writeFileSync(path.join(d, 'data', 'core.json'), '{"v":2}\n');
  cli(['seed', `--seed=${seed}`], { LAND_TSC_STAMP_FILE: stamp2 });
  assert.equal(cli(push, { LAND_TSC_STAMP_FILE: stamp2 }).status, 1, 'drifted core data: tsc runs');
  assert.notEqual(dataDigest({ cwd: d }), seed.split(':')[1]);
  // data mutated after digest-pre (mid-gauntlet) => no export
  assert.equal(cli(['seed-export', `--meta=${metaFile}`, `--rebased=${head}`, `--pre=${preFile}`, `--tree-status=${okTs}`]).stdout.trim(), '');
  // tsc-time residue in src => no export
  const tsFile = path.join(d, 'ts-src');
  fs.writeFileSync(tsFile, ' M src/a.ts\n');
  assert.equal(cli(['seed-export', `--meta=${metaFile}`, `--rebased=${head}`, `--pre=${preFile}`, `--tree-status=${tsFile}`]).stdout.trim(), '');
});
