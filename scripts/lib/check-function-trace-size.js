#!/usr/bin/env node
/**
 * Post-build check (BRO-8154): fail when any traced server function would
 * exceed Vercel's 250 MB uncompressed limit, BEFORE the ~1.3 GB upload.
 *
 * On 2026-11-23 api/admin/ingest-review/detect traced 341 MB and every prod
 * deploy failed for ~7 hours; the error only surfaced after the upload
 * (BRO-8136 fixed that one; BRO-6277/6305/6310 were earlier size regressions).
 *
 * For every .next/server/**\/*.nft.json: resolve each listed file against the
 * json's own directory, sum the sizes of the files that exist (node_modules
 * counts, Vercel counts it), and fail above the limit. Prints the function
 * name and its 5 biggest files.
 *
 * Usage: node scripts/lib/check-function-trace-size.js [.next dir] [--limit-mb=230]
 * Exit 0 = every function under the limit, 1 = at least one over, 2 = no build
 * output, no traces, or most traced files missing (resolution broken).
 */
'use strict';

const fs = require('fs');
const path = require('path');

// Vercel's cap is 250 MB; fail at 230 MB so a function is caught before it is
// close enough that one dependency bump breaks the deploy.
const DEFAULT_LIMIT_MB = 230;
const MB = 1024 * 1024;
const MAX_MISSING_RATIO = 0.5;

/**
 * Pure sizing of one trace. `statSize(absPath)` returns a byte size for a
 * regular file or null for anything missing / not a file, so tests can run
 * against a fixture tree or a stub.
 *
 * @param {{files?: string[]}} nft  parsed .nft.json
 * @param {string} nftDir           directory the listed paths are relative to
 * @param {(abs: string) => (number|null)} statSize
 * @param {number} [topN]
 * @returns {{ totalBytes: number, fileCount: number, missing: number, top: {file: string, bytes: number}[] }}
 */
function sizeTrace(nft, nftDir, statSize, topN = 5) {
  const seen = new Set();
  const sized = [];
  let missing = 0;
  for (const rel of (nft && nft.files) || []) {
    const abs = path.resolve(nftDir, rel);
    if (seen.has(abs)) continue; // a file listed twice is shipped once
    seen.add(abs);
    const bytes = statSize(abs);
    if (bytes == null) { missing++; continue; }
    sized.push({ file: abs, bytes });
  }
  const totalBytes = sized.reduce((sum, f) => sum + f.bytes, 0);
  sized.sort((a, b) => b.bytes - a.bytes || (a.file < b.file ? -1 : 1));
  return { totalBytes, fileCount: sized.length, missing, top: sized.slice(0, topN) };
}

/** Real-filesystem statSize: regular files only (symlinks followed, as the bundler does). */
function fsStatSize(abs) {
  try {
    const st = fs.statSync(abs);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

/** Every *.nft.json under dir, recursive, sorted. */
function findNftFiles(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.nft.json')) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * @param {string} serverDir  .next/server
 * @param {{limitBytes: number, statSize?: Function}} opts
 * @returns {{ name: string, totalBytes: number, over: boolean, fileCount: number, missing: number, top: object[] }[]}
 */
function scanTraces(serverDir, { limitBytes, statSize: rawStat = fsStatSize }) {
  // Traces share most node_modules files; stat each absolute path once.
  const cache = new Map();
  const statSize = (abs) => {
    if (!cache.has(abs)) cache.set(abs, rawStat(abs));
    return cache.get(abs);
  };
  return findNftFiles(serverDir).map((nftPath) => {
    let nft;
    try { nft = JSON.parse(fs.readFileSync(nftPath, 'utf8')); } catch { nft = { files: [] }; }
    const r = sizeTrace(nft, path.dirname(nftPath), statSize);
    const name = path.relative(serverDir, nftPath).split(path.sep).join('/').replace(/\.js\.nft\.json$|\.nft\.json$/, '');
    return { name, ...r, over: r.totalBytes > limitBytes };
  });
}

function main() {
  const args = process.argv.slice(2);
  const limitArg = args.find((a) => a.startsWith('--limit-mb='));
  const limitMb = limitArg ? Number(limitArg.split('=')[1]) : DEFAULT_LIMIT_MB;
  const nextDir = path.resolve(args.find((a) => !a.startsWith('--')) || '.next');
  const repoRoot = path.dirname(nextDir);
  const serverDir = path.join(nextDir, 'server');
  if (!Number.isFinite(limitMb) || limitMb <= 0) { console.log(`bad --limit-mb: ${limitArg}`); process.exit(2); }
  if (!fs.existsSync(serverDir)) { console.log(`no build output at ${serverDir}`); process.exit(2); }

  const results = scanTraces(serverDir, { limitBytes: limitMb * MB });
  // Fail closed: a path-resolution break would size every file as missing and
  // report 0 MB, which must not read as healthy.
  const listed = results.reduce((n, r) => n + r.fileCount + r.missing, 0);
  const missing = results.reduce((n, r) => n + r.missing, 0);
  if (!results.length) { console.log(`no .nft.json traces under ${serverDir}`); process.exit(2); }
  console.log(`${listed - missing}/${listed} traced files found on disk (${missing} missing)`);
  if (listed && missing / listed > MAX_MISSING_RATIO) {
    console.log(`more than ${MAX_MISSING_RATIO * 100}% of traced files are missing: path resolution is likely broken`);
    process.exit(2);
  }
  const over = results.filter((r) => r.over).sort((a, b) => b.totalBytes - a.totalBytes);
  const largest = [...results].sort((a, b) => b.totalBytes - a.totalBytes)[0];
  console.log(`checked ${results.length} traces, limit ${limitMb} MB (Vercel caps at 250 MB)` +
    (largest ? `; largest: ${largest.name} ${(largest.totalBytes / MB).toFixed(1)} MB` : ''));
  for (const r of over) {
    console.log(`::warning title=Function trace over ${limitMb} MB::${r.name} traces ${(r.totalBytes / MB).toFixed(1)} MB`);
    console.log(`FAIL ${r.name}: ${(r.totalBytes / MB).toFixed(1)} MB across ${r.fileCount} files (limit ${limitMb} MB)`);
    for (const f of r.top) console.log(`       ${(f.bytes / MB).toFixed(1).padStart(7)} MB  ${path.relative(repoRoot, f.file).split(path.sep).join('/')}`);
  }
  process.exit(over.length ? 1 : 0);
}

module.exports = { sizeTrace, scanTraces, findNftFiles, fsStatSize, DEFAULT_LIMIT_MB };

if (require.main === module) main();
