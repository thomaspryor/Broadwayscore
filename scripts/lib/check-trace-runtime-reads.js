#!/usr/bin/env node
/**
 * Post-build check (BRO-8155): a route whose compiled code reads
 * an inlined data file (REDUNDANT_INLINED_JSON) with fs must still have that file in its traced files.
 * next.config.js drops the file from every other route's trace
 * (scripts/lib/trace-route-excludes.js), because webpack already inlined it.
 *
 * Usage: node scripts/lib/check-trace-runtime-reads.js [.next dir]
 * Exit 0 ok, 1 a route reads the file at runtime but does not trace it,
 * 2 no build output.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { REDUNDANT_INLINED_JSON } = require('./trace-route-excludes');

// A compiled fs read names the file as path.join(.., 'data', 'x.json'),
// 'data/x.json' (cwd + '/data/x.json', join(cwd, 'data/x.json'), ../data/x.json) or a
// bare 'x.json' segment (join(dataDir, 'x.json')). A URL like `/show/${slug}/x.json`
// has a slash before the name inside a longer literal, so it matches none of these.
function readsFileRegex(file) {
  const name = path.posix.basename(file).replace(/\./g, '\\.');
  return new RegExp(`["']data["']\\s*,\\s*["']${name}["']|data\\/${name}|["']${name}["']`);
}
const READS_FILE = readsFileRegex('data/reviews.json'); // kept for tests

/**
 * @param {string} nftPath a .nft.json written by next build
 * @param {string} repoRoot
 * @returns {{ file: string, traced: boolean, readers: string[] }[]} per data file:
 *   traced = it is in the trace; readers = traced compiled files whose code names it.
 */
function inspectNft(nftPath, repoRoot, files = REDUNDANT_INLINED_JSON) {
  const nft = JSON.parse(fs.readFileSync(nftPath, 'utf8'));
  const dir = path.dirname(nftPath);
  const res = new Map(files.map((f) => [f, { file: f, traced: false, readers: [], re: readsFileRegex(f) }]));
  for (const f of nft.files || []) {
    const abs = path.resolve(dir, f);
    const rel = path.relative(repoRoot, abs).split(path.sep).join('/');
    if (res.has(rel)) { res.get(rel).traced = true; continue; }
    if (rel.startsWith('node_modules/') || !abs.endsWith('.js')) continue;
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    for (const r of res.values()) if (r.re.test(text)) r.readers.push(rel);
  }
  return [...res.values()].map(({ file, traced, readers }) => ({ file, traced, readers }));
}

function listNfts(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.nft.json')) out.push(p);
    }
  })(dir);
  return out;
}

function main() {
  const nextDir = path.resolve(process.argv[2] || '.next');
  const repoRoot = path.dirname(nextDir);
  const serverDir = path.join(nextDir, 'server');
  if (!fs.existsSync(serverDir)) { console.error(`no build output at ${serverDir}`); process.exit(2); }
  let failed = 0;
  const nfts = listNfts(serverDir);
  const stillTraced = Object.fromEntries(REDUNDANT_INLINED_JSON.map((f) => [f, 0]));
  for (const nft of nfts) {
    for (const { file, traced, readers } of inspectNft(nft, repoRoot)) {
      if (traced) stillTraced[file]++;
      if (!traced && readers.length) {
        failed++;
        console.log(`FAIL ${path.relative(serverDir, nft)}: reads ${file} but does not trace it (${readers.slice(0, 2).join(', ')}). Add the route to REVIEWS_JSON_FS_READERS in scripts/lib/trace-route-excludes.js, or remove ${file} from REDUNDANT_INLINED_JSON`);
      }
    }
  }
  console.log(`checked ${nfts.length} traces; still traced: ${JSON.stringify(stillTraced)}; ${failed} read an inlined file untraced`);
  process.exit(failed ? 1 : 0);
}

if (require.main === module) main();

module.exports = { inspectNft, readsFileRegex, READS_FILE };
