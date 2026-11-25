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
 * Usage: node scripts/lib/check-function-trace-size.js [.next dir] [--limit-mb=180]
 *        node scripts/lib/check-function-trace-size.js --vercel-output [.vercel/output dir] [--limit-mb=180]
 *
 * --vercel-output (BRO-8165) measures the PACKAGED functions, the thing Vercel's
 * 250 MB limit actually applies to: every .vercel/output/functions/**\/*.func
 * directory, symlinks followed, `.vc-config.json` filePathMap targets added,
 * each real lambda counted once. It fails closed (exit 2) when the output is
 * missing or the largest function is implausibly small (< 5 MB), which means
 * the measurement is broken, not that the build is healthy (--min-largest-mb=N
 * overrides the floor).
 * Exit 0 = every function under the limit, 1 = at least one over, 2 = no build
 * output, no traces, or most traced files missing (resolution broken).
 */
'use strict';

const fs = require('fs');
const path = require('path');

// BRO-8159: the prior worker reported maxima across 10 main runs of 143.3 MB
// traced and 147.5 MB packaged. 180 MB leaves 32.5 MB (22%) above the latter,
// and 70 MB below Vercel's 250 MB cap. Run IDs were not retained in the report;
// recheck the measurements as builds change. Both workflow checks are armed for exit 1 only; exit 2 (measurement broken) warns and passes (BRO-8159).
const DEFAULT_LIMIT_MB = 180;
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

/**
 * Size one packaged .func directory (BRO-8165). Walks the tree with lstat,
 * follows symlinks (dedupe by realpath so a file or dir reached twice counts
 * once, and a symlink cycle ends), and adds the files named by
 * `.vc-config.json` filePathMap (repo-relative targets Vercel packs into the
 * lambda without copying them into the .func dir).
 *
 * @param {string} funcDir
 * @param {{repoRoot?: string, topN?: number, fsx?: object}} [opts]
 * @returns {{ totalBytes: number, fileCount: number, top: {file: string, bytes: number}[] }}
 */
function sizeFuncDir(funcDir, { repoRoot = process.cwd(), topN = 10, fsx = fs } = {}) {
  const seenReal = new Set();
  const sized = [];
  const errors = [];
  const addFile = (abs, label) => {
    let real;
    let st;
    try { real = fsx.realpathSync(abs); st = fsx.statSync(real); } catch (e) { errors.push(`stat ${abs}: ${e.code || e.message}`); return; }
    if (!st.isFile() || seenReal.has(real)) return;
    seenReal.add(real);
    sized.push({ file: label || abs, bytes: st.size });
  };
  const walk = (dir) => {
    let real;
    try { real = fsx.realpathSync(dir); } catch (e) { errors.push(`realpath ${dir}: ${e.code || e.message}`); return; }
    if (seenReal.has('dir:' + real)) return; // symlink cycle or dir reached twice
    seenReal.add('dir:' + real);
    let entries;
    try { entries = fsx.readdirSync(dir, { withFileTypes: true }); } catch (e) { errors.push(`readdir ${dir}: ${e.code || e.message}`); return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isSymbolicLink()) {
        let st;
        try { st = fsx.statSync(p); } catch (err) { errors.push(`dangling link ${p}: ${err.code || err.message}`); continue; }
        if (st.isDirectory()) walk(p); else addFile(p);
      } else addFile(p);
    }
  };
  walk(funcDir);
  // filePathMap: {<path inside the lambda>: <repo-relative source>}. Each KEY is a
  // separate packaged file, so one source mapped to two keys counts twice.
  let cfg = null;
  try { cfg = JSON.parse(fsx.readFileSync(path.join(funcDir, '.vc-config.json'), 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') errors.push(`.vc-config.json in ${funcDir}: ${e.code || e.message}`);
  }
  for (const [dest, target] of Object.entries((cfg && cfg.filePathMap) || {})) {
    if (typeof target !== 'string') continue;
    const abs = path.resolve(repoRoot, target);
    try {
      const st = fsx.statSync(abs);
      if (st.isFile()) sized.push({ file: abs, bytes: st.size, dest });
    } catch (e) { errors.push(`filePathMap ${dest} -> ${target}: ${e.code || e.message}`); }
  }
  const totalBytes = sized.reduce((sum, f) => sum + f.bytes, 0);
  sized.sort((a, b) => b.bytes - a.bytes || (a.file < b.file ? -1 : 1));
  return { totalBytes, fileCount: sized.length, top: sized.slice(0, topN), errors };
}

/** Every *.func directory under functionsDir (not descending into one), sorted. */
function findFuncDirs(functionsDir) {
  const out = [];
  const visited = new Set();
  const walk = (d) => {
    let real;
    try { real = fs.realpathSync(d); } catch { return; }
    if (visited.has(real)) return; // symlink cycle
    visited.add(real);
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      let isDir = e.isDirectory();
      if (!isDir && e.isSymbolicLink()) {
        let st = null;
        try { st = fs.statSync(p); } catch { /* dangling link: not a directory */ }
        isDir = !!st && st.isDirectory();
      }
      if (!isDir) continue;
      if (e.name.endsWith('.func')) out.push(p); else walk(p); // symlinked route dirs too
    }
  };
  walk(functionsDir);
  return out.sort();
}

/**
 * Size every packaged function. Several routes can symlink to one real lambda;
 * those are one function (deduped by realpath), reported under the first name.
 *
 * @returns {{ name: string, totalBytes: number, over: boolean, fileCount: number, top: object[], aliases: string[] }[]}
 */
function scanFuncOutput(functionsDir, { limitBytes, repoRoot, fsx = fs }) {
  const byReal = new Map();
  for (const dir of findFuncDirs(functionsDir)) {
    let real;
    try { real = fsx.realpathSync(dir); } catch { continue; }
    const name = path.relative(functionsDir, dir).split(path.sep).join('/').replace(/\.func$/, '');
    if (byReal.has(real)) { byReal.get(real).aliases.push(name); continue; }
    byReal.set(real, { name, dir, aliases: [] });
  }
  return [...byReal.values()].map(({ name, dir, aliases }) => {
    const r = sizeFuncDir(dir, { repoRoot, fsx });
    return { name, aliases, ...r, over: r.totalBytes > limitBytes };
  });
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

// A real Next lambda ships Next's runtime (tens of MB). A "largest function" below
// this means the walk found nothing, not that the build is small.
const MIN_PLAUSIBLE_LARGEST_MB = 5;

function mainVercelOutput(outDirArg, limitMb, limitArg) {
  const outDir = path.resolve(outDirArg);
  const functionsDir = path.join(outDir, 'functions');
  const bail = (msg) => { console.log(`::warning title=Packaged function size check could not run::${msg}`); console.log(msg); process.exit(2); };
  if (!Number.isFinite(limitMb) || limitMb <= 0) bail(`bad --limit-mb: ${limitArg}`);
  if (!fs.existsSync(functionsDir)) bail(`no packaged functions at ${functionsDir}`);
  const repoRoot = path.dirname(path.dirname(outDir)); // <repo>/.vercel/output -> <repo>
  const minArg = process.argv.slice(2).find((a) => a.startsWith('--min-largest-mb='));
  const minLargestMb = minArg ? Number(minArg.split('=')[1]) : MIN_PLAUSIBLE_LARGEST_MB;
  if (!Number.isFinite(minLargestMb) || minLargestMb < 0) bail(`bad ${minArg}`);
  const results = scanFuncOutput(functionsDir, { limitBytes: limitMb * MB, repoRoot });
  if (!results.length) bail(`no *.func directories under ${functionsDir}`);
  const ranked = [...results].sort((a, b) => b.totalBytes - a.totalBytes);
  for (const r of ranked.slice(0, 10)) {
    console.log(`${(r.totalBytes / MB).toFixed(1).padStart(7)} MB  ${String(r.fileCount).padStart(6)} files  ${r.name}${r.aliases.length ? ` (+${r.aliases.length} aliases)` : ''}`);
  }
  console.log(`checked ${results.length} packaged functions, limit ${limitMb} MB (Vercel caps at 250 MB); largest: ${ranked[0].name} ${(ranked[0].totalBytes / MB).toFixed(1)} MB`);
  if (ranked[0].totalBytes < minLargestMb * MB) {
    bail(`largest packaged function is only ${(ranked[0].totalBytes / MB).toFixed(1)} MB (< ${minLargestMb} MB): the measurement is broken, not healthy`);
  }
  const over = ranked.filter((r) => r.over);
  const unmeasured = ranked.filter((r) => r.errors && r.errors.length);
  for (const r of unmeasured) {
    console.log(`::warning title=Packaged function not fully measured::${r.name}: ${r.errors.length} problem(s), first: ${r.errors[0]}`);
  }
  for (const r of over) {
    console.log(`::warning title=Packaged function over ${limitMb} MB::${r.name} is ${(r.totalBytes / MB).toFixed(1)} MB`);
    console.log(`FAIL ${r.name}: ${(r.totalBytes / MB).toFixed(1)} MB across ${r.fileCount} files (limit ${limitMb} MB)`);
    for (const f of r.top) console.log(`       ${(f.bytes / MB).toFixed(1).padStart(7)} MB  ${path.relative(repoRoot, f.file).split(path.sep).join('/')}`);
  }
  if (!over.length && unmeasured.length) {
    bail(`${unmeasured.length} packaged function(s) could not be fully measured (see warnings); a total that skips files cannot prove the size is under the limit`);
  }
  process.exit(over.length ? 1 : 0);
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
  const vercelMode = args.includes('--vercel-output');
  if (vercelMode) return mainVercelOutput(args.find((a, i) => !used.has(i) && !a.startsWith('--')) || '.vercel/output', limitMb, limitArg);
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

module.exports = { sizeTrace, scanTraces, findNftFiles, fsStatSize, sizeFuncDir, findFuncDirs, scanFuncOutput, DEFAULT_LIMIT_MB };

if (require.main === module) main();
