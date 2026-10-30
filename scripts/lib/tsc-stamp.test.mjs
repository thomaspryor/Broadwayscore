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
const { decide, computeKey, decideHook, hookKey } = require('./tsc-stamp.js');
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

// BRO-6508: hook-tail stamp ("audits + workflow lints passed on this tree").
test('hookKey: stable across bot churn (incl. top-level data JSON) and file-list order; changes on allowlists, files, tip message', () => {
  const r = mkRepo({});
  const base = r.commit({ 'src/a.ts': 'x\n', 'data/shows.json': '[]', 'data/audit/x.json': '1', '.cron-health-exempt.txt': 'a\n' });
  const k = (sha, files = 'src/a.ts\nscripts/b.js', tip = 'msg\n') =>
    hookKey({ lsTree: r.g('ls-tree', '-r', sha), changedFiles: files, tipMessage: tip });
  assert.match(k(base), /^[0-9a-f]{64}$/);
  const churn = r.commit({ 'data/audit/x.json': '2', 'public/images/shows/a.webp': 'i', 'public/data/shows/a.json': '{}' });
  assert.equal(k(churn), k(base), 'bot data/public churn must not change the key');
  assert.equal(k(base, '\nscripts/b.js\nsrc/a.ts\nsrc/a.ts\n'), k(base), 'file list order, blanks and dupes do not matter');
  assert.notEqual(k(base, 'src/a.ts'), k(base), 'a different pushed file list changes the key');
  assert.notEqual(k(base, undefined, 'msg\n[skip-cron-audit]\n'), k(base), 'the tip message is in the key');
  const allow = r.commit({ '.cron-health-exempt.txt': 'b\n' });
  assert.notEqual(k(allow), k(churn), 'a root .txt allowlist (inert to the verdict) must change the hook key');
  const json = r.commit({ 'data/shows.json': '[1]' });
  assert.equal(k(json), k(allow), 'a bot rewrite of a top-level data JSON keeps the audit stamp (tsc has its own)');
  assert.notEqual(r.key(json), r.key(allow), '...while the tsc key still changes');
  const other = r.commit({ 'public/robots.txt': 'x' });
  assert.notEqual(k(other), k(json), 'public/ outside data/ and images/ stays in the key');
  assert.equal(hookKey({ lsTree: '', changedFiles: 'a', tipMessage: '' }), '', 'no tree -> no hook key');
  fs.rmSync(r.d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('decideHook: same refusals as decide(), and only hook: lines count', () => {
  const { stampLines, ...rest } = ok;
  assert.equal(decideHook({ ...rest, stampLines: [`hook:${K}`] }).skip, true);
  assert.equal(decideHook({ ...rest, stampLines: [K] }).skip, false, 'a tsc stamp line is not a hook stamp');
  assert.equal(decideHook({ ...rest, stampLines: [`hook:${K}`], specCount: 2 }).skip, false);
  assert.equal(decideHook({ ...rest, stampLines: [`hook:${K}`], env: {} }).skip, false);
  assert.equal(decideHook({ ...rest, stampLines: [`hook:${K}`], remoteRef: 'refs/heads/land/x' }).skip, false);
});

test('CLI: hook-record then hook-check skips; tsc check stays separate; other file list or dirty tree runs', () => {
  const r = mkRepo({});
  r.commit({ 'src/a.ts': 'x\n', 'data/shows.json': '[]' });
  const stamp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hook-stamp-')), 'stamp'); // outside the repo: commit -A would track it
  const env = { ...process.env, GITHUB_ACTIONS: 'true', LAND_TSC_STAMP_FILE: stamp };
  const args = [`--pushed-oid=${r.g('rev-parse', 'HEAD')}`, '--spec-count=1', '--remote-ref=refs/heads/main'];
  const run = (cmd, input = '\nsrc/a.ts\n', e = env) => spawnSync('node', [SCRIPT, cmd, ...args], { cwd: r.d, env: e, input, encoding: 'utf8' });
  assert.equal(run('hook-check').status, 1, 'no stamp yet -> run the hook');
  assert.equal(run('hook-record').status, 0);
  assert.match(fs.readFileSync(stamp, 'utf8'), /^hook:[0-9a-f]{64}\n$/);
  assert.equal(run('hook-check').status, 0, 'same tree + files -> skip');
  assert.equal(run('check').status, 1, 'a hook stamp never skips tsc check on its own');
  r.commit({ 'data/shows.json': '[1]' });
  const args2 = [`--pushed-oid=${r.g('rev-parse', 'HEAD')}`, '--spec-count=1', '--remote-ref=refs/heads/main'];
  assert.equal(spawnSync('node', [SCRIPT, 'hook-check', ...args2], { cwd: r.d, env, input: '\nsrc/a.ts\n', encoding: 'utf8' }).status, 0, 'bot data JSON move -> audits still skip');
  assert.equal(spawnSync('node', [SCRIPT, 'check', ...args2], { cwd: r.d, env, encoding: 'utf8' }).status, 1, '...but tsc runs');
  assert.equal(run('hook-check', 'src/a.ts\nsrc/b.ts\n').status, 1, 'different file list -> run');
  assert.equal(run('hook-check', undefined, { ...env, LAND_TSC_STAMP_FILE: '' }).status, 1, 'kill switch (blank file var) -> run');
  fs.writeFileSync(path.join(r.d, 'src/a.ts'), 'dirty\n');
  assert.equal(run('hook-check').status, 1, 'dirty tree -> run');
  fs.rmSync(r.d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ── BRO-6519: pre-warm the hook tail in the checks job, seed it in the Land job ──
const { hookDirtyLines, decideHookSeedExport } = require('./tsc-stamp.js');

test('hookDirtyLines: data/ and public/data|images residue is not dirt for the hook stamp; code, renames out of it are', () => {
  assert.deepEqual(hookDirtyLines(' M data/gold-lists-computed.json\n M public/data/x.json\n'), []);
  assert.deepEqual(hookDirtyLines(' M src/a.ts\n'), [' M src/a.ts']);
  assert.deepEqual(hookDirtyLines('R  data/a.json -> scripts/a.js\n'), ['R  data/a.json -> scripts/a.js']);
  assert.deepEqual(hookDirtyLines('R  scripts/a.js -> data/a.json\n'), ['R  scripts/a.js -> data/a.json']);
  assert.deepEqual(hookDirtyLines(' M .cron-health-exempt.txt\n'), [' M .cron-health-exempt.txt'], 'root allowlists are in the key, so they are dirt');
  assert.deepEqual(hookDirtyLines(''), []);
});

test('decideHookSeedExport: seeds only a recorded key on the rebased sha with unchanged core data', () => {
  const base = { rebased: R, headOid: R, key: K, stampLines: [`hook:${K}`], digest: D, preDigest: D };
  assert.equal(decideHookSeedExport(base).seed, `${K}:${D}`);
  for (const [name, patch] of [
    ['HEAD moved', { headOid: H }],
    ['no rebased sha', { rebased: '' }],
    ['tsc line only', { stampLines: [K] }],
    ['nothing recorded', { stampLines: [] }],
    ['no key', { key: '' }],
    ['data moved', { preDigest: 'f'.repeat(64) }],
    ['no pre digest', { preDigest: '' }],
  ]) assert.equal(decideHookSeedExport({ ...base, ...patch }).seed, '', name);
});

test('CLI hook pre-warm end to end: checks-job record -> export -> Land-job seed skips the FIRST hook-check; residue tolerated; drifted data does not seed', () => {
  const r = mkRepo({});
  const base = r.commit({ 'src/a.ts': 'x\n', '.gitignore': 'data/core.json\n', 'data/gold-lists-computed.json': '{}\n' });
  const head = r.commit({ 'src/a.ts': 'y\n', 'scripts/b.js': 'z\n' });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-prewarm-'));
  const core = path.join(r.d, 'data', 'core.json'); // gitignored core data, as the jobs clone it
  fs.writeFileSync(core, '{"v":1}\n');
  const files = r.g('diff', '--name-only', `${base}..${head}`);
  const cli = (args, stamp, input = files) => spawnSync('node', [SCRIPT, ...args], { cwd: r.d, input, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true', LAND_TSC_STAMP_FILE: stamp } });
  const pre = path.join(tmp, 'pre');
  const warm = path.join(tmp, 'warm');
  cli(['digest-pre', `--out=${pre}`], warm);
  // The gauntlet's gold-lists prep leaves this tracked file dirty in the checks job.
  fs.writeFileSync(path.join(r.d, 'data', 'gold-lists-computed.json'), '{"x":1}\n');
  assert.equal(cli(['hook-seed-export', `--rebased=${head}`, `--pre=${pre}`], warm).stdout.trim(), '', 'nothing recorded yet -> no seed');
  assert.equal(cli(['hook-record'], warm).status, 0);
  assert.match(fs.readFileSync(warm, 'utf8'), /^hook:[0-9a-f]{64}\n$/, 'recorded despite data/ residue');
  const seed = cli(['hook-seed-export', `--rebased=${head}`, `--pre=${pre}`], warm).stdout.trim();
  assert.match(seed, /^[0-9a-f]{64}:[0-9a-f]{64}$/);
  assert.equal(cli(['hook-seed-export', `--rebased=${base}`, `--pre=${pre}`], warm).stdout.trim(), '', 'not the rebased sha -> no seed');
  // Land job: fresh stamp file, the push range is the same branch diff.
  const land = path.join(tmp, 'land');
  const push = ['hook-check', `--pushed-oid=${head}`, '--spec-count=1', '--remote-ref=refs/heads/main'];
  assert.equal(cli(push, land).status, 1, 'unseeded: the tail runs');
  cli(['hook-seed', `--seed=${seed}`], land);
  assert.match(fs.readFileSync(land, 'utf8'), /^hook:[0-9a-f]{64}\n$/);
  assert.equal(cli(push, land).status, 0, 'seeded: the FIRST push skips the tail');
  assert.equal(cli(['check', `--pushed-oid=${head}`, '--spec-count=1', '--remote-ref=refs/heads/main'], land).status, 1, 'a hook seed never skips tsc');
  assert.equal(cli(push, land, 'src/a.ts\n').status, 1, 'a different pushed file list still runs');
  // Land job cloned different core data -> not seeded.
  fs.writeFileSync(core, '{"v":2}\n');
  const land2 = path.join(tmp, 'land2');
  cli(['hook-seed', `--seed=${seed}`], land2);
  assert.equal(fs.existsSync(land2), false, 'drifted core data: no hook seed');
  // core data moved during the pre-warm -> no export
  assert.equal(cli(['hook-seed-export', `--rebased=${head}`, `--pre=${pre}`], warm).stdout.trim(), '');
  // a dirty code file in the checks job -> no export
  fs.writeFileSync(core, '{"v":1}\n');
  fs.writeFileSync(path.join(r.d, 'scripts', 'b.js'), 'dirty\n');
  assert.equal(cli(['hook-seed-export', `--rebased=${head}`, `--pre=${pre}`], warm).stdout.trim(), '');
  fs.rmSync(r.d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('land.yml wires the hook pre-warm: checks job runs the real hook + exports, Land job seeds before landing', () => {
  const y = fs.readFileSync(path.resolve(import.meta.dirname, '../../.github/workflows/land.yml'), 'utf8');
  assert.match(y, /hook_seed: \$\{\{ steps\.hookseed\.outputs\.seed \}\}/);
  const warm = y.slice(y.indexOf('id: hookseed'), y.indexOf('echo "seed=$SEED"', y.indexOf('id: hookseed')));
  assert.match(warm, /bash scripts\/hooks\/pre-push/, 'runs the real hook, not a copy of its tail');
  assert.match(warm, /hook-seed-export --rebased="\$REBASED"/);
  assert.doesNotMatch(warm, /then\n\s*SEED=\$\(git diff/, "the export does not hang off the hook exit code (a later tsc red is not the tail's)");
  assert.match(warm, /git diff --name-only "\$BASE\.\.\$REBASED"/, 'the same file list the Land push range gives');
  assert.doesNotMatch(warm, /GH_TOKEN/, 'no token: the Land step has none either (audit-workflow-hygiene calls the API only with one)');
  assert.match(warm, /continue-on-error: true/);
  const seedAt = y.indexOf('tsc-stamp.js hook-seed --seed=');
  assert.ok(seedAt > 0 && seedAt < y.indexOf('- name: Land the branch'), 'seeded before the Land step');
});

test('CLI tsc check/record tolerate only the gold-lists prep residue (TSC_INERT_RESIDUE), as seed-export does', () => {
  const r = mkRepo({});
  const head = r.commit({ 'src/a.ts': 'x\n', 'data/gold-lists-computed.json': '{}\n' });
  const stamp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tsc-residue-')), 'stamp');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', LAND_TSC_STAMP_FILE: stamp };
  const run = (cmd) => spawnSync('node', [SCRIPT, cmd, `--pushed-oid=${head}`, '--spec-count=1', '--remote-ref=refs/heads/main'], { cwd: r.d, env, encoding: 'utf8' });
  fs.writeFileSync(path.join(r.d, 'data', 'gold-lists-computed.json'), '{"x":1}\n');
  assert.equal(run('record').status, 0);
  assert.equal(run('check').status, 0, 'gold-lists residue only -> recorded and skipped');
  fs.writeFileSync(path.join(r.d, 'src', 'a.ts'), 'dirty\n');
  assert.equal(run('check').status, 1, 'any other tracked dirt still runs tsc');
  fs.rmSync(r.d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.rmSync(path.dirname(stamp), { recursive: true, force: true });
});
