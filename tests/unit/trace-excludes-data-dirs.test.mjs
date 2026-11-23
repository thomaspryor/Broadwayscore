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
//   3. When the real trees exist, the real detect-route graph stays small.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const config = require(join(ROOT, 'next.config.js'));
const excludes = (config.outputFileTracingExcludes || {})['**/*'] || [];

const BIG_DATA_TREES = [
  'data/aggregator-archive/**',
  'data/video-reviews-transcripts/**',
  'data/pending-fixes/**',
  'data/archive/**',
  'data/*.pre-symlink-backup',
  'data/diary-shows.json',
];
// Read at runtime by pending-intake.js, so they must stay traceable.
const MUST_STAY_TRACEABLE = ['data/shows.json', 'data/reviews.json'];

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
    writeFileSync(join(base, 'data/reviews.json.pre-symlink-backup'), '{}');
    writeFileSync(join(base, 'data/shows.json'), '[]');
    writeFileSync(join(base, 'data/reviews.json'), '{}');
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
    assert.ok(traced.includes('data/shows.json'), 'runtime-read data/shows.json must still be traced');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('real detect-route graph stays under the function size budget (when data is present)', async () => {
  const nodeFileTrace = nft();
  const entries = [
    'scripts/lib/review-normalization.js',
    'scripts/lib/byline-normalization.js',
    'scripts/lib/critic-fill-rules.js',
    'scripts/lib/review-write-guard.js',
  ];
  if (!nodeFileTrace || !entries.every(e => existsSync(join(ROOT, e)))) return;
  const { fileList } = await nodeFileTrace(entries, {
    base: ROOT,
    processCwd: ROOT,
    ignore: [...excludes, 'node_modules/**'],
  });
  let total = 0;
  for (const f of fileList) {
    try {
      const st = statSync(join(ROOT, f));
      if (st.isFile()) total += st.size;
    } catch { /* file vanished or unreadable */ }
  }
  const mb = total / 1e6;
  // Vercel's hard limit is 250MB uncompressed including node_modules; the
  // repo-file part of this graph measured 138MB on 2026-11-23 after the fix.
  assert.ok(mb < 200, `detect route traces ${mb.toFixed(0)}MB of repo files (budget 200MB); a data/ tree is leaking in`);
});

// Root-cause guard (works in a bare CI checkout, needs no data): follow the
// relative require() graph from the detect route's entry modules and fail on
// any module that names the data/ DIRECTORY itself (path.join(..., 'data') with
// no file after it). Name the file instead: path.join(__dirname,'..','..','data','x.json').
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('modules reachable from the ingest detect route never name the data/ directory', () => {
  const entries = [
    'scripts/lib/review-normalization.js',
    'scripts/lib/byline-normalization.js',
    'scripts/lib/critic-fill-rules.js',
    'scripts/lib/review-write-guard.js',
  ].map(e => join(ROOT, e)).filter(existsSync);
  const seen = new Set();
  const queue = [...entries];
  const offenders = [];
  // path.join(<anything>, 'data') or path.resolve(...,'data') closing right after 'data'.
  const dirOnly = /path\.(?:join|resolve)\([^)\n]*['"]data['"]\s*\)/;
  while (queue.length) {
    const f = queue.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const src = readFileSync(f, 'utf8');
    if (dirOnly.test(src)) offenders.push(f.slice(ROOT.length + 1));
    for (const m of src.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      const base = resolve(dirname(f), m[1]);
      const hit = [base, base + '.js', join(base, 'index.js')].find(p => existsSync(p) && statSync(p).isFile());
      if (hit) queue.push(hit);
    }
  }
  assert.ok(seen.size > 5, `graph walk found only ${seen.size} modules; the walker is broken`);
  assert.deepEqual(offenders, [], 'these modules name the data/ directory, so NFT bundles all of data/ into the function (BRO-8136)');
});
