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
 * @param {string[]} [sharedAbs]    absolute paths every function also ships (Next's shared runtime)
 * @returns {{ totalBytes: number, fileCount: number, missing: number, top: {file: string, bytes: number}[] }}
 */
function sizeTrace(nft, nftDir, statSize, topN = 5, sharedAbs = []) {
  const seen = new Set();
  const sized = [];
  let missing = 0;
  const all = [...(((nft && nft.files) || []).map((rel) => path.resolve(nftDir, rel))), ...sharedAbs];
  for (const abs of all) {
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
function scanTraces(serverDir, { limitBytes, statSize: rawStat = fsStatSize, extraNftFiles = [] }) {
  // Traces share most node_modules files; stat each absolute path once.
  const cache = new Map();
  const statSize = (abs) => {
    if (!cache.has(abs)) cache.set(abs, rawStat(abs));
    return cache.get(abs);
  };
  const read = (nftPath) => {
    try {
      const nft = JSON.parse(fs.readFileSync(nftPath, 'utf8'));
      if (!nft || !Array.isArray(nft.files)) return { nft: { files: [] }, unreadable: true };
      return { nft, unreadable: false };
    } catch { return { nft: { files: [] }, unreadable: true }; }
  };
  // Vercel ships Next's shared runtime (.next/next-server.js.nft.json ...) in every
  // lambda, so those files count toward each function's size, not as a function.
  const shared = extraNftFiles.map((f) => ({ f, ...read(f) }));
  const sharedAbs = shared.flatMap(({ f, nft }) => nft.files.map((rel) => path.resolve(path.dirname(f), rel)));
  const sharedBad = shared.filter((x) => x.unreadable).map((x) => ({
    name: path.relative(serverDir, x.f).split(path.sep).join('/'), totalBytes: 0, over: false, fileCount: 0, missing: 0, top: [], unreadable: true,
  }));
  const own = findNftFiles(serverDir).map((nftPath) => {
    const { nft, unreadable } = read(nftPath);
    const r = sizeTrace(nft, path.dirname(nftPath), statSize, 5, sharedAbs);
    const name = path.relative(serverDir, nftPath).split(path.sep).join('/').replace(/\.js\.nft\.json$|\.nft\.json$/, '');
    return { name, ...r, unreadable, over: r.totalBytes > limitBytes };
  });
  return [...own, ...sharedBad];
}

function main() {
  const args = process.argv.slice(2);
  // Accept both `--limit-mb=200` and `--limit-mb 200`.
  const li = args.findIndex((a) => a === '--limit-mb' || a.startsWith('--limit-mb='));
  let limitArg;
  let limitRaw;
  const used = new Set();
  if (li >= 0) {
    used.add(li);
    if (args[li] === '--limit-mb') { limitRaw = args[li + 1]; used.add(li + 1); limitArg = `--limit-mb ${limitRaw}`; }
    else { limitRaw = args[li].split('=')[1]; limitArg = args[li]; }
  }
  const limitMb = li >= 0 ? (limitRaw === undefined || limitRaw === '' ? NaN : Number(limitRaw)) : DEFAULT_LIMIT_MB;
  const nextDir = path.resolve(args.find((a, i) => !used.has(i) && !a.startsWith('--')) || '.next');
  const repoRoot = path.dirname(nextDir);
  const serverDir = path.join(nextDir, 'server');
  // Every fail-closed exit also prints an annotation: with continue-on-error a
  // broken check must still be visible on the run, not a green step.
  const bail = (msg) => { console.log(`::warning title=Trace size check could not run::${msg}`); console.log(msg); process.exit(2); };
  if (!Number.isFinite(limitMb) || limitMb <= 0) bail(`bad --limit-mb: ${limitArg}`);
  if (!fs.existsSync(serverDir)) bail(`no build output at ${serverDir}`);

  // Shared runtime traces (.next/next-server.js.nft.json ...) sit beside server/; Vercel ships them in lambdas.
  const rootTraces = fs.readdirSync(nextDir).filter((f) => f.endsWith('.nft.json')).map((f) => path.join(nextDir, f));
  const results = scanTraces(serverDir, { limitBytes: limitMb * MB, extraNftFiles: rootTraces });
  // Fail closed: a path-resolution break would size every file as missing and
  // report 0 MB, which must not read as healthy.
  const listed = results.reduce((n, r) => n + r.fileCount + r.missing, 0);
  const missing = results.reduce((n, r) => n + r.missing, 0);
  if (!results.length) bail(`no .nft.json traces under ${serverDir}`);
  const unreadable = results.filter((r) => r.unreadable);
  if (unreadable.length) bail(`${unreadable.length} unreadable .nft.json trace(s), e.g. ${unreadable[0].name}`);
  if (listed === 0) bail('traces list no files at all');
  console.log(`${listed - missing}/${listed} traced files found on disk (${missing} missing)`);
  if (listed && missing / listed > MAX_MISSING_RATIO) {
    bail(`more than ${MAX_MISSING_RATIO * 100}% of traced files are missing: path resolution is likely broken`);
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
