// BRO-8150: the pre-deploy function size guard must catch a function that
// Vercel would reject with NOW_SANDBOX_WORKER_MAX_UNCOMPRESSED_FUNCTION_SIZE
// (2026-11-23: api/admin/ingest-review/detect traced all of data/, 341MB).
// Fixtures use sparse files so a "341MB" file costs no disk.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, truncateSync, symlinkSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { checkOutput, FAIL_BYTES, WARN_BYTES } = require('../../scripts/lib/check-function-bundle-size.js');
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'lib', 'check-function-bundle-size.js');
const MB = 1024 * 1024;

function sparse(p, bytes) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, '');
  truncateSync(p, bytes);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fnsize-'));
  const out = join(root, '.vercel', 'output');
  // small function with files inside the .func dir
  const small = join(out, 'functions', 'api', 'health.func');
  sparse(join(small, 'index.js'), 2 * MB);
  writeFileSync(join(small, '.vc-config.json'), JSON.stringify({ runtime: 'nodejs20.x' }));
  // big function whose traced files live in the project via filePathMap (Next builder shape)
  const big = join(out, 'functions', 'api', 'admin', 'ingest-review', 'detect.func');
  mkdirSync(big, { recursive: true });
  sparse(join(root, 'data', 'aggregator-archive', 'a.html'), 300 * MB);
  sparse(join(root, 'data', 'shows.json'), 41 * MB);
  sparse(join(root, '.next', 'server', 'app', 'api', 'detect.js'), 1 * MB);
  writeFileSync(join(big, '.vc-config.json'), JSON.stringify({
    runtime: 'nodejs20.x',
    filePathMap: {
      'data/aggregator-archive/a.html': 'data/aggregator-archive/a.html',
      'data/shows.json': 'data/shows.json',
      '.next/server/app/api/detect.js': '.next/server/app/api/detect.js',
    },
  }));
  // a symlinked duplicate of the small function must be counted once, not fail
  symlinkSync(small, join(out, 'functions', 'api', 'health-alias.func'));
  return { root, out };
}

test('flags the 341MB detect function and names the traced data dir', () => {
  const { root, out } = fixture();
  try {
    const res = checkOutput(out, { projectRoot: root });
    assert.equal(res.funcs.length, 2, 'symlinked duplicate .func is deduped');
    const detect = res.funcs.find((f) => f.name.endsWith('detect'));
    assert.ok(detect.bytes >= 342 * MB && detect.bytes < 342 * MB + 4096, String(detect.bytes)); // + .vc-config.json
    assert.equal(detect.level, 'fail');
    assert.deepEqual(detect.missing, []);
    assert.equal(res.rootLooksWrong, false);
    assert.equal(detect.files[0].path, 'data/aggregator-archive/a.html');
    const health = res.funcs.find((f) => f.name.includes('health'));
    assert.equal(health.level, 'ok');
    assert.equal(res.failed.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI exits 1 on an oversized function and prints the function name', () => {
  const { root, out } = fixture();
  try {
    const r = spawnSync(process.execPath, [SCRIPT, out, `--project-root=${root}`], { encoding: 'utf8' });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /::error::function api\/admin\/ingest-review\/detect is 342\.0MB/);
    assert.match(r.stdout, /data\/aggregator-archive 300\.0MB/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('kill switch reports but exits 0', () => {
  const { root, out } = fixture();
  try {
    const r = spawnSync(process.execPath, [SCRIPT, out, `--project-root=${root}`], {
      encoding: 'utf8', env: { ...process.env, FUNCTION_SIZE_GUARD_DISABLED: 'true' },
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /::error::function api\/admin\/ingest-review\/detect/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('warn band (>=200MB, <240MB) does not fail; healthy output exits 0', () => {
  const root = mkdtempSync(join(tmpdir(), 'fnsize-'));
  const out = join(root, '.vercel', 'output');
  try {
    sparse(join(out, 'functions', 'api', 'og.func', 'big.bin'), WARN_BYTES + MB);
    sparse(join(out, 'functions', 'api', 'tiny.func', 'index.js'), 10_000);
    const res = checkOutput(out, { projectRoot: root });
    assert.equal(res.warned.length, 1);
    assert.equal(res.failed.length, 0);
    assert.ok(WARN_BYTES < FAIL_BYTES && FAIL_BYTES < 250 * MB);
    const r = spawnSync(process.execPath, [SCRIPT, out, `--project-root=${root}`], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /::warning::function api\/og/);
    assert.match(r.stdout, /OK \(not failing\): .* 1 over the 200\.0MB warning line/, 'a warn-band run must not claim nothing is near the limit');
    assert.doesNotMatch(r.stdout, /no function near the size limit/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing functions dir exits 2', () => {
  const root = mkdtempSync(join(tmpdir(), 'fnsize-'));
  try {
    const r = spawnSync(process.execPath, [SCRIPT, join(root, 'nope')], { encoding: 'utf8' });
    assert.equal(r.status, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('wrong project root fails loud (exit 2) instead of undercounting to a pass', () => {
  const { root, out } = fixture();
  const elsewhere = mkdtempSync(join(tmpdir(), 'fnsize-root-'));
  try {
    const r = spawnSync(process.execPath, [SCRIPT, out, `--project-root=${elsewhere}`], { encoding: 'utf8' });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /filePathMap entries are missing/);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(elsewhere, { recursive: true, force: true }); }
});

test('.rsc.func dirs are skipped like the Vercel CLI analysis', () => {
  const root = mkdtempSync(join(tmpdir(), 'fnsize-'));
  const out = join(root, '.vercel', 'output');
  try {
    sparse(join(out, 'functions', 'page.rsc.func', 'big.bin'), 300 * MB);
    sparse(join(out, 'functions', 'page.func', 'index.js'), MB);
    const res = checkOutput(out, { projectRoot: root });
    assert.deepEqual(res.funcs.map((f) => f.name), ['page']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The BLOCKING half of BRO-8150 is Vercel's own analysis, which only runs when
// VERCEL_ANALYZE_BUILD_OUTPUT=1. Fail if the workflow drops the flag or a CLI
// bump stops honoring it (it is undocumented).
test('deploy Build step enables the Vercel CLI size analysis, and the CLI still honors it', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const wf = readFileSync(join(ROOT, '.github', 'workflows', 'vercel-deploy.yml'), 'utf8');
  const build = wf.match(/\n      - name: Build\n([\s\S]*?)\n      - name: /);
  assert.ok(build, 'Build step not found in vercel-deploy.yml');
  const FLAG = /VERCEL_ANALYZE_BUILD_OUTPUT: \$\{\{ vars\.FUNCTION_SIZE_BLOCK_DISABLED == 'true' && '0' \|\| '1' \}\}/;
  assert.match(build[1], FLAG, 'Build step must enable VERCEL_ANALYZE_BUILD_OUTPUT (default on)');
  for (const other of ['vercel-preview.yml', 'vercel-demo.yml']) {
    assert.match(readFileSync(join(ROOT, '.github', 'workflows', other), 'utf8'), FLAG, `${other} must enable the size analysis too`);
  }
  assert.match(readFileSync(join(ROOT, 'scripts', 'deploy-now.js'), 'utf8'), /VERCEL_ANALYZE_BUILD_OUTPUT:/, 'deploy-now.js must enable the size analysis too');
  assert.match(build[1], /npx vercel build/);
  assert.match(wf, /check-function-bundle-size\.js \.vercel\/output/, 'advisory early-warning step missing');
  // Resolve like require() does (walks up), so a worktree without its own
  // node_modules still checks the installed CLI. In CI (npm ci ran) a missing
  // or moved CLI file is a failure, never a silent skip.
  let pkg;
  try { pkg = require.resolve('vercel/package.json', { paths: [ROOT] }); } catch { /* not installed */ }
  if (!pkg) {
    assert.ok(!process.env.CI, 'vercel CLI not installed in CI; cannot verify it honors VERCEL_ANALYZE_BUILD_OUTPUT');
    return; // bare local checkout: workflow half still checked
  }
  const cli = readFileSync(join(dirname(pkg), 'dist', 'commands', 'build', 'index.js'), 'utf8');
  assert.match(cli, /process\.env\.VERCEL_ANALYZE_BUILD_OUTPUT === "1"/, 'installed vercel CLI no longer reads VERCEL_ANALYZE_BUILD_OUTPUT');
  assert.match(cli, /NOW_SANDBOX_WORKER_MAX_LAMBDA_SIZE/, 'installed vercel CLI no longer throws on oversized functions');
});

test('two map entries symlinked to one source dir are both counted; non-string and trailing-slash entries are safe', () => {
  const root = mkdtempSync(join(tmpdir(), 'fnsize-'));
  const out = join(root, '.vercel', 'output');
  try {
    sparse(join(root, 'shared', 'blob.bin'), 100 * MB);
    const fn = join(out, 'functions', 'api', 'x.func');
    mkdirSync(join(fn, 'links'), { recursive: true });
    symlinkSync(join(root, 'shared'), join(fn, 'links', 'a'));
    symlinkSync(join(root, 'shared'), join(fn, 'links', 'b'));
    writeFileSync(join(fn, '.vc-config.json'), JSON.stringify({ filePathMap: { 'bad': 42, 'shared/': 'shared' } }));
    const res = checkOutput(out, { projectRoot: root });
    const x = res.funcs[0];
    // links/a + links/b + shared (via map) = 300MB
    assert.ok(x.bytes >= 300 * MB && x.bytes < 300 * MB + 4096, String(x.bytes));
    assert.equal(x.mapped, 1, 'non-string target ignored like the CLI');
    assert.ok(x.files.some((f) => f.path === 'shared/blob.bin'), 'trailing slash normalised');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('symlink loop back to an ancestor terminates', () => {
  const root = mkdtempSync(join(tmpdir(), 'fnsize-'));
  const out = join(root, '.vercel', 'output');
  try {
    const fn = join(out, 'functions', 'loop.func');
    sparse(join(fn, 'd', 'f.bin'), MB);
    symlinkSync(fn, join(fn, 'd', 'up'));
    const res = checkOutput(out, { projectRoot: root });
    assert.ok(res.funcs[0].bytes >= MB && res.funcs[0].bytes < 2 * MB, String(res.funcs[0].bytes));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unreadable .vc-config.json is reported, not silently treated as empty', () => {
  const root = mkdtempSync(join(tmpdir(), 'fnsize-'));
  const out = join(root, '.vercel', 'output');
  try {
    sparse(join(out, 'functions', 'broken.func', 'index.js'), MB);
    writeFileSync(join(out, 'functions', 'broken.func', '.vc-config.json'), '{not json');
    const r = spawnSync(process.execPath, [SCRIPT, out, `--project-root=${root}`], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /::warning::function broken: unreadable \.vc-config\.json/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
