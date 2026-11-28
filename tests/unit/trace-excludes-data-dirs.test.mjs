// BRO-8136: a module in an API function's require graph that builds a path
// to data/ with path.join(__dirname, '..', '..', 'data') makes Next's file
// tracing (NFT) copy the whole data/ tree into that function. On 2026-11-23
// scripts/lib/pending-intake.js (BRO-8089) did exactly that via
// review-write-guard.js, and api/admin/ingest-review/detect grew to 341MB
// (limit 250MB): every production deploy failed from 07:24 UTC until the big
// private data trees were added to outputFileTracingExcludes.
//
// Three checks, so the guard works in a bare CI checkout (where the big
// private trees are absent) and on a machine that has them:
//   1. next.config.js still excludes each big data/ tree.
//   2. A synthetic fixture shaped like pending-intake.js, traced with the
//      config's own excludes, does not drag those trees in (fails if an
//      exclude is dropped or stops matching).
//   3. (real detect-route size budget: trace-excludes-data-dirs-live-data.test.mjs,
//      which reads the private core data and so runs in the live-data lane.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, statSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Read the excludes from next.config.js as text. Loading the config would run
// its prebuild side effect (writeSiteImageVersions reads untracked data/), which
// would make this blocking test depend on live data (BRO-7101 live-data lane).
function readExcludes() {
  const text = readFileSync(join(ROOT, 'next.config.js'), 'utf8');
  const m = text.match(/outputFileTracingExcludes:\s*\{\s*'\*\*\/\*':\s*\[([\s\S]*?)\n\s*\],\s*\n(?:\s*\.\.\.[^\n]*\n)?\s*\},/);
  assert.ok(m, 'could not find outputFileTracingExcludes["**/*"] in next.config.js');
  return new Function(`return [${m[1]}];`)();
}
const excludes = readExcludes();
assert.ok(excludes.length > 5, 'outputFileTracingExcludes parsed to fewer than 6 entries');

const BIG_DATA_TREES = [
  'data/aggregator-archive/**',
  'data/video-reviews-transcripts/**',
  'data/pending-fixes/**',
  'data/archive/**',
  'data/*.pre-symlink-backup',
  'data/diary-shows.json',
];
// Read at runtime by pending-intake.js, so they must stay traceable.
const MUST_STAY_TRACEABLE = [['data', 'shows.json'].join('/'), ['data', 'reviews.json'].join('/')];

function nft() {
  try {
    return require(join(ROOT, 'node_modules/next/dist/compiled/@vercel/nft')).nodeFileTrace;
  } catch {
    return null;
  }
}

test('next.config.js excludes the big data/ trees from function traces', () => {
  for (const g of BIG_DATA_TREES) {
    assert.ok(excludes.includes(g), `outputFileTracingExcludes["**/*"] must include ${g}`);
  }
  for (const f of MUST_STAY_TRACEABLE) {
    assert.ok(!excludes.includes(f), `${f} is read at runtime and must not be excluded`);
  }
});

test('a module that joins __dirname/../../data does not pull the big trees in', async () => {
  const nodeFileTrace = nft();
  if (!nodeFileTrace) return; // node_modules absent: check 1 still guards the config
  const base = mkdtempSync(join(tmpdir(), 'trace-data-'));
  try {
    mkdirSync(join(base, 'scripts/lib'), { recursive: true });
    for (const d of ['aggregator-archive', 'video-reviews-transcripts', 'pending-fixes', 'archive']) {
      mkdirSync(join(base, 'data', d), { recursive: true });
      writeFileSync(join(base, 'data', d, 'big.json'), '{}');
    }
    writeFileSync(join(base, 'data/diary-shows.json'), '{}');
    writeFileSync(join(base, 'data', 'reviews.json.pre-symlink-backup'), '{}');
    writeFileSync(join(base, 'data', 'shows.json'), '[]');
    writeFileSync(join(base, 'data', 'reviews.json'), '{}');
    // Same shape as scripts/lib/pending-intake.js.
    writeFileSync(
      join(base, 'scripts/lib/intake.js'),
      "const fs=require('fs'),path=require('path');\n" +
        "const DATA_DIR=path.join(__dirname,'..','..','data');\n" +
        "module.exports=()=>JSON.parse(fs.readFileSync(path.join(DATA_DIR,'shows.json'),'utf8'));\n",
    );
    const { fileList } = await nodeFileTrace([join(base, 'scripts/lib/intake.js')], {
      base,
      processCwd: base,
      ignore: excludes,
    });
    const traced = [...fileList];
    const leaked = traced.filter(f =>
      /^data\/(aggregator-archive|video-reviews-transcripts|pending-fixes|archive)\//.test(f) ||
      /^data\/diary-shows\.json$/.test(f) ||
      /pre-symlink-backup$/.test(f),
    );
    assert.deepEqual(leaked, [], 'big data/ trees were traced into the function bundle');
    assert.ok(traced.includes(MUST_STAY_TRACEABLE[0]), 'the runtime-read shows file must still be traced');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// Root-cause guard (works in a bare CI checkout, needs no data): follow the
// relative require() graph from the detect route's entry modules and fail on
// any module that names the data/ DIRECTORY itself (path.join(..., 'data') with
// no file after it). Name the file instead: path.join(__dirname,'..','..','data','x.json').

test('modules reachable from src/ server code never name the data/ directory', () => {
  // Entries: every scripts/lib module that src/ loads through cjsRequire(...)
  // (admin-ingest-detect.ts uses createRequire, so a plain import scan misses
  // it), plus the detect route's own helpers.
  const entrySet = new Set([
    'review-normalization', 'byline-normalization', 'critic-fill-rules', 'review-write-guard',
  ].map(n => join(ROOT, 'scripts/lib', n + '.js')));
  for (const f of walkSrc(join(ROOT, 'src'))) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/scripts\/lib\/([A-Za-z0-9_./-]+?)['"]/g)) {
      const base = join(ROOT, 'scripts/lib', m[1]);
      const hit = [base, base + '.js', join(base, 'index.js')].find(p => existsSync(p) && statSync(p).isFile());
      if (hit) entrySet.add(hit);
    }
  }
  const seen = new Set();
  const queue = [...entrySet].filter(existsSync);
  const offenders = [];
  // A path.join/resolve whose 'data' (or '../../data', 'data/') argument is the
  // last argument, or is followed by a non-literal argument: both name the
  // directory itself, so NFT bundles the whole tree. Multi-line aware.
  const dataArg = String.raw`['"](?:\.{1,2}\/)*data\/?['"]`;
  const dirOnly = new RegExp(String.raw`path\.(?:join|resolve)\([^;]*?${dataArg}\s*(?:\)|,\s*[^'"\s])`);
  while (queue.length) {
    const f = queue.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const src = readFileSync(f, 'utf8');
    if (dirOnly.test(src)) offenders.push(f.slice(ROOT.length + 1));
    for (const m of src.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      const base = resolve(dirname(f), m[1]);
      // Follow code only: a require() of a data/*.json table is a runtime read of
      // a file we must not open here (this test stays independent of live data).
      if (/\.json$/.test(base) || base.startsWith(join(ROOT, 'data'))) continue;
      const hit = [base, base + '.js', join(base, 'index.js')].find(p => existsSync(p) && statSync(p).isFile());
      if (hit) queue.push(hit);
    }
  }
  assert.ok(seen.size > 50, `graph walk found only ${seen.size} modules; the walker is broken`);
  assert.deepEqual(offenders, [], 'these modules name the data/ directory, so NFT bundles all of data/ into the function (BRO-8136)');
});

test('the data-directory pattern flags the known-bad shapes and spares file paths', () => {
  const dataArg = String.raw`['"](?:\.{1,2}\/)*data\/?['"]`;
  const dirOnly = new RegExp(String.raw`path\.(?:join|resolve)\([^;]*?${dataArg}\s*(?:\)|,\s*[^'"\s])`);
  for (const bad of [
    "path.join(__dirname, '..', '..', 'data')",
    "path.join(__dirname, '../../data')",
    "path.resolve(__dirname,'../../../data')",
    "path.join(__dirname, '..', '..', 'data/')",
    "path.join(\n  __dirname,\n  '..',\n  'data',\n)",
    "path.join(ROOT, 'data', sub)",
  ]) assert.ok(dirOnly.test(bad), `should flag: ${bad}`);
  for (const ok of [
    "path.join(__dirname, '..', '..', 'data', 'shows.json')",
    "path.join(__dirname, '../../data/x.json')",
    "path.join(dataDir, 'shows.json')",
  ]) assert.ok(!dirOnly.test(ok), `should not flag: ${ok}`);
});

function walkSrc(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkSrc(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}
