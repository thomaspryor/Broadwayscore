// BRO-8154: the post-build trace size check. Requires the real functions
// (CLAUDE.md §15), runs them on a fixture .next/server tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { sizeTrace, scanTraces, DEFAULT_LIMIT_MB } = require('./check-function-trace-size.js');
const SCRIPT = join(import.meta.dirname, 'check-function-trace-size.js');
const KB = 1024;

test('sizeTrace sums existing files, dedupes, counts missing, ranks the top files', () => {
  const sizes = { '/r/a': 100, '/r/b': 300, '/r/c': 200, '/r/d': 50 };
  const r = sizeTrace(
    { files: ['a', 'b', 'a', 'c', 'gone', 'd'] }, '/r', (p) => (p in sizes ? sizes[p] : null), 2);
  assert.equal(r.totalBytes, 650);
  assert.equal(r.fileCount, 4);
  assert.equal(r.missing, 1);
  assert.deepEqual(r.top.map((f) => f.bytes), [300, 200]);
});

test('sizeTrace resolves paths against the json directory and tolerates an empty trace', () => {
  const seen = [];
  sizeTrace({ files: ['../../node_modules/x/index.js'] }, '/r/.next/server/app', (p) => { seen.push(p); return 1; });
  assert.deepEqual(seen, ['/r/.next/node_modules/x/index.js']);
  assert.equal(sizeTrace({}, '/r', () => 1).totalBytes, 0);
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'trace-size-'));
  const server = join(root, '.next', 'server', 'app', 'api');
  mkdirSync(server, { recursive: true });
  mkdirSync(join(root, 'node_modules', 'big'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'big', 'blob.bin'), Buffer.alloc(300 * KB));
  writeFileSync(join(root, 'small.js'), Buffer.alloc(10 * KB));
  const trace = (files) => JSON.stringify({ version: 1, files });
  writeFileSync(join(server, 'under.js.nft.json'), trace(['../../../../small.js']));
  writeFileSync(join(server, 'over.js.nft.json'), trace(['../../../../small.js', '../../../../node_modules/big/blob.bin']));
  return root;
}

test('scanTraces flags only the function over the limit, with a readable name', () => {
  const root = fixture();
  try {
    const res = scanTraces(join(root, '.next', 'server'), { limitBytes: 100 * KB });
    const byName = Object.fromEntries(res.map((r) => [r.name, r]));
    assert.equal(byName['app/api/under'].over, false);
    assert.equal(byName['app/api/over'].over, true);
    assert.equal(byName['app/api/over'].top[0].bytes, 300 * KB);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('scanTraces boundary: exactly at the limit passes, one byte over fails', () => {
  const root = fixture();
  try {
    const dir = join(root, '.next', 'server');
    const exact = scanTraces(dir, { limitBytes: 310 * KB }).find((r) => r.name === 'app/api/over');
    assert.equal(exact.totalBytes, 310 * KB);
    assert.equal(exact.over, false);
    assert.equal(scanTraces(dir, { limitBytes: 310 * KB - 1 }).find((r) => r.name === 'app/api/over').over, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('shared runtime traces at the .next root add to every function; null files is unreadable', () => {
  const root = fixture();
  try {
    writeFileSync(join(root, '.next', 'next-server.js.nft.json'), JSON.stringify({ files: ['../node_modules/big/blob.bin'] }));
    // shared runtime is added to every function, not judged alone: under (10 KB + 300 KB blob) ok at 305 KB, over at 309 KB
    const res = scanTraces(join(root, '.next', 'server'), { limitBytes: 1e9, extraNftFiles: [join(root, '.next', 'next-server.js.nft.json')] });
    assert.equal(res.find((r) => r.name === 'app/api/under').totalBytes, 310 * KB);
    assert.equal(res.some((r) => r.name.includes('next-server')), false);
    writeFileSync(join(root, '.next', 'server', 'app', 'api', 'bad.js.nft.json'), JSON.stringify({ files: null }));
    assert.equal(scanTraces(join(root, '.next', 'server'), { limitBytes: 1e9 }).find((r) => r.name === 'app/api/bad').unreadable, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI exits 1 and names the biggest files when over, 0 when under, 2 with no build', () => {
  const root = fixture();
  try {
    const next = join(root, '.next');
    const over = spawnSync('node', [SCRIPT, next, '--limit-mb=0.1'], { encoding: 'utf8' });
    assert.equal(over.status, 1);
    assert.match(over.stdout, /FAIL app\/api\/over/);
    assert.match(over.stdout, /node_modules\/big\/blob\.bin/);
    const under = spawnSync('node', [SCRIPT, next, '--limit-mb=1'], { encoding: 'utf8' });
    assert.equal(under.status, 0);
    // Fail closed: traces whose files are all missing must not read as 0 MB.
    const bad = join(root, '.next', 'server', 'app', 'api', 'broken.js.nft.json');
    writeFileSync(bad, JSON.stringify({ version: 1, files: ['nope1.js', 'nope2.js'] }));
    const broken = spawnSync('node', [SCRIPT, next, '--limit-mb=1'], { encoding: 'utf8' });
    assert.equal(broken.status, 0, 'one broken trace among healthy ones stays under the ratio');
    const emptyRoot = mkdtempSync(join(tmpdir(), 'trace-empty-'));
    mkdirSync(join(emptyRoot, '.next', 'server'), { recursive: true });
    assert.equal(spawnSync('node', [SCRIPT, join(emptyRoot, '.next')], { encoding: 'utf8' }).status, 2);
    mkdirSync(join(emptyRoot, '.next', 'server', 'app'), { recursive: true });
    writeFileSync(join(emptyRoot, '.next', 'server', 'app', 'x.js.nft.json'), JSON.stringify({ files: ['a', 'b'] }));
    assert.equal(spawnSync('node', [SCRIPT, join(emptyRoot, '.next')], { encoding: 'utf8' }).status, 2);
    rmSync(emptyRoot, { recursive: true, force: true });
    // Unreadable trace, boundary (> not >=), space-form limit, bad limit, annotation on fail-closed exits.
    const corruptRoot = mkdtempSync(join(tmpdir(), 'trace-corrupt-'));
    mkdirSync(join(corruptRoot, '.next', 'server', 'app'), { recursive: true });
    writeFileSync(join(corruptRoot, '.next', 'server', 'app', 'c.js.nft.json'), '{not json');
    const corrupt = spawnSync('node', [SCRIPT, join(corruptRoot, '.next')], { encoding: 'utf8' });
    assert.equal(corrupt.status, 2);
    assert.match(corrupt.stdout, /::warning title=Trace size check could not run::/);
    rmSync(corruptRoot, { recursive: true, force: true });
    const spaced = spawnSync('node', [SCRIPT, next, '--limit-mb', '0.1'], { encoding: 'utf8' });
    assert.equal(spaced.status, 1, 'space-form limit applies and is not read as the .next dir');
    assert.match(over.stdout, /::warning title=Function trace over/);
    assert.equal(spawnSync('node', [SCRIPT, next, '--limit-mb=abc'], { encoding: 'utf8' }).status, 2);
    assert.equal(spawnSync('node', [SCRIPT, next, '--limit-mb='], { encoding: 'utf8' }).status, 2);
    const none = spawnSync('node', [SCRIPT, join(root, 'nope')], { encoding: 'utf8' });
    assert.equal(none.status, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---- BRO-8165: packaged .vercel/output/functions/*.func measurement ----
import { symlinkSync, truncateSync } from 'node:fs';
const { sizeFuncDir, scanFuncOutput } = require('./check-function-trace-size.js');
const MB = 1024 * 1024;

function vercelFixture() {
  const root = mkdtempSync(join(tmpdir(), 'func-size-'));
  const fns = join(root, '.vercel', 'output', 'functions');
  mkdirSync(join(fns, 'api', 'a.func', 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(fns, 'api', 'a.func', 'index.js'), Buffer.alloc(10 * KB));
  writeFileSync(join(fns, 'api', 'a.func', 'node_modules', 'x', 'big.bin'), Buffer.alloc(300 * KB));
  // b.func is a route alias of the same real lambda as a.func
  symlinkSync(join(fns, 'api', 'a.func'), join(fns, 'api', 'b.func'));
  // c.func: own tree + symlinked file (same real file as in a) + cycle + filePathMap target outside the dir
  mkdirSync(join(fns, 'c.func'), { recursive: true });
  writeFileSync(join(fns, 'c.func', 'own.js'), Buffer.alloc(20 * KB));
  symlinkSync(join(fns, 'api', 'a.func', 'index.js'), join(fns, 'c.func', 'linked.js'));
  symlinkSync(join(fns, 'c.func'), join(fns, 'c.func', 'loop'));
  writeFileSync(join(root, 'mapped.bin'), Buffer.alloc(200 * KB));
  writeFileSync(join(fns, 'c.func', '.vc-config.json'), JSON.stringify({ filePathMap: { 'mapped.bin': 'mapped.bin' } }));
  return { root, fns, out: join(root, '.vercel', 'output') };
}

test('calibrated default gates packaged functions on either side of 180 MB', () => {
  assert.equal(DEFAULT_LIMIT_MB, 180);
  const { root, fns, out } = vercelFixture();
  try {
    const big = join(fns, 'api', 'a.func', 'node_modules', 'x', 'boundary.bin');
    writeFileSync(big, '');
    // The other files in a.func total 310 KB, so these straddle the default.
    truncateSync(big, DEFAULT_LIMIT_MB * MB - 310 * KB);
    const under = spawnSync('node', [SCRIPT, '--vercel-output', out], { encoding: 'utf8' });
    assert.equal(under.status, 0, under.stdout);
    truncateSync(big, DEFAULT_LIMIT_MB * MB - 310 * KB + 1);
    const over = spawnSync('node', [SCRIPT, '--vercel-output', out], { encoding: 'utf8' });
    assert.equal(over.status, 1, over.stdout);
    assert.match(over.stdout, /FAIL api\/a/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('sizeFuncDir counts files, follows symlinks once, survives cycles, adds filePathMap targets', () => {
  const { root, fns } = vercelFixture();
  try {
    const a = sizeFuncDir(join(fns, 'api', 'a.func'), { repoRoot: root });
    assert.equal(a.totalBytes, 310 * KB);
    assert.equal(a.top[0].bytes, 300 * KB);
    const c = sizeFuncDir(join(fns, 'c.func'), { repoRoot: root });
    // own.js 20 + linked.js 10 (symlink to a real file, counted once) + mapped.bin 200 + .vc-config.json
    assert.equal(c.totalBytes, 20 * KB + 10 * KB + 200 * KB + Buffer.byteLength(JSON.stringify({ filePathMap: { 'mapped.bin': 'mapped.bin' } })));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('scanFuncOutput folds symlinked route aliases into one lambda and flags only the one over', () => {
  const { root, fns } = vercelFixture();
  try {
    const res = scanFuncOutput(fns, { limitBytes: 250 * KB, repoRoot: root });
    assert.equal(res.length, 2, 'a.func and its b.func alias are one lambda');
    const a = res.find((r) => r.name === 'api/a');
    assert.deepEqual(a.aliases, ['api/b']);
    assert.equal(a.over, true);
    assert.equal(res.find((r) => r.name === 'c').over, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI --vercel-output: a 260 MB function fails with the biggest file named (red), under the limit passes (green)', () => {
  const { root, fns, out } = vercelFixture();
  try {
    const big = join(fns, 'api', 'a.func', 'node_modules', 'x', 'huge.bin');
    writeFileSync(big, '');
    truncateSync(big, 260 * MB); // sparse: size counts, disk does not
    const red = spawnSync('node', [SCRIPT, '--vercel-output', out, '--min-largest-mb=0'], { encoding: 'utf8' });
    assert.equal(red.status, 1, red.stdout);
    assert.match(red.stdout, /FAIL api\/a: 26\d\.\d MB/);
    assert.match(red.stdout, /huge\.bin/);
    rmSync(big);
    const green = spawnSync('node', [SCRIPT, '--vercel-output', out, '--min-largest-mb=0'], { encoding: 'utf8' });
    assert.equal(green.status, 0, green.stdout);
    assert.match(green.stdout, /checked 2 packaged functions/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI --vercel-output fails closed (exit 2): missing output, no .func dirs, implausibly small largest function', () => {
  const { root, out } = vercelFixture();
  try {
    assert.equal(spawnSync('node', [SCRIPT, '--vercel-output', join(root, 'nope')], { encoding: 'utf8' }).status, 2);
    // default floor (5 MB): the 310 KB fixture reads as a broken measurement, not a healthy build
    const small = spawnSync('node', [SCRIPT, '--vercel-output', out], { encoding: 'utf8' });
    assert.equal(small.status, 2);
    assert.match(small.stdout, /measurement is broken/);
    const empty = mkdtempSync(join(tmpdir(), 'func-empty-'));
    mkdirSync(join(empty, 'functions'), { recursive: true });
    assert.equal(spawnSync('node', [SCRIPT, '--vercel-output', empty], { encoding: 'utf8' }).status, 2);
    rmSync(empty, { recursive: true, force: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('BRO-8165 review: one source mapped to two lambda paths counts twice; unreadable inputs are reported, not hidden', () => {
  const root = mkdtempSync(join(tmpdir(), 'func-map-'));
  try {
    const fns = join(root, '.vercel', 'output', 'functions');
    mkdirSync(join(fns, 'm.func'), { recursive: true });
    writeFileSync(join(root, 'src.bin'), Buffer.alloc(100 * KB));
    writeFileSync(join(fns, 'm.func', '.vc-config.json'), JSON.stringify({ filePathMap: { 'one/src.bin': 'src.bin', 'two/src.bin': 'src.bin', 'gone.bin': 'missing.bin' } }));
    const r = sizeFuncDir(join(fns, 'm.func'), { repoRoot: root });
    const cfgBytes = Buffer.byteLength(JSON.stringify({ filePathMap: { 'one/src.bin': 'src.bin', 'two/src.bin': 'src.bin', 'gone.bin': 'missing.bin' } }));
    assert.equal(r.totalBytes, 200 * KB + cfgBytes, 'two destinations = two copies');
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /missing\.bin/);
    // corrupt config is an error too
    writeFileSync(join(fns, 'm.func', '.vc-config.json'), '{not json');
    assert.match(sizeFuncDir(join(fns, 'm.func'), { repoRoot: root }).errors[0], /vc-config/);
    // dangling symlink
    symlinkSync(join(root, 'nowhere'), join(fns, 'm.func', 'dangling'));
    assert.ok(sizeFuncDir(join(fns, 'm.func'), { repoRoot: root }).errors.some((e) => /dangling/.test(e)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('BRO-8165 review: functions under a symlinked route directory are found; unmeasurable functions exit 2 unless one is over', () => {
  const root = mkdtempSync(join(tmpdir(), 'func-symdir-'));
  try {
    const out = join(root, '.vercel', 'output');
    const fns = join(out, 'functions');
    mkdirSync(join(root, 'real-routes', 'z.func'), { recursive: true });
    writeFileSync(join(root, 'real-routes', 'z.func', 'z.bin'), '');
    truncateSync(join(root, 'real-routes', 'z.func', 'z.bin'), 6 * MB);
    mkdirSync(fns, { recursive: true });
    symlinkSync(join(root, 'real-routes'), join(fns, 'api'));
    const found = scanFuncOutput(fns, { limitBytes: 250 * MB, repoRoot: root });
    assert.deepEqual(found.map((f) => f.name), ['api/z']);
    // healthy but one unreadable config: exit 2 (cannot prove under the limit)
    writeFileSync(join(root, 'real-routes', 'z.func', '.vc-config.json'), '{bad');
    const bad = spawnSync('node', [SCRIPT, '--vercel-output', out], { encoding: 'utf8' });
    assert.equal(bad.status, 2, bad.stdout);
    assert.match(bad.stdout, /not fully measured/);
    // same, but over the limit: the real failure (exit 1) wins
    const over = spawnSync('node', [SCRIPT, '--vercel-output', out, '--limit-mb=5'], { encoding: 'utf8' });
    assert.equal(over.status, 1, over.stdout);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// BRO-8159: vercel-deploy.yml arms only exit 1. A crash in the checker must come out as
// exit 2 (a ::warning), never as Node's default exit 1, or it would block a healthy deploy.
test('an unexpected throw inside the checker exits 2 with a ::warning, not 1', () => {
  const root = fixture();
  try {
    const next = join(root, '.next');
    const preload = join(root, 'boom.cjs');
    writeFileSync(preload, "const fs=require('fs');const r=fs.readdirSync;fs.readdirSync=function(p,...a){if(String(p).endsWith('.next'))throw new Error('boom');return r.call(this,p,...a);};");
    const res = spawnSync('node', ['-r', preload, SCRIPT, next], { encoding: 'utf8' });
    assert.equal(res.status, 2, res.stdout + res.stderr);
    assert.match(res.stdout, /::warning title=Function size check crashed/);
    assert.match(res.stdout, /boom/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
