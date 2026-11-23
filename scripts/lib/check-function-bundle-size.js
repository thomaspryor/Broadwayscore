#!/usr/bin/env node
/**
 * check-function-bundle-size.js (BRO-8150)
 *
 * Measures the uncompressed size of every serverless function in a prebuilt
 * Vercel output (`.vercel/output/functions/**\/*.func`) and fails BEFORE
 * `vercel deploy --prebuilt` uploads anything when one is near Vercel's 250MB
 * uncompressed limit.
 *
 * Why: on 2026-11-23 Next's file tracing pulled all of data/ into
 * api/admin/ingest-review/detect (341MB). `vercel build` succeeded, the upload
 * succeeded, and only Vercel's server rejected it with
 * NOW_SANDBOX_WORKER_MAX_UNCOMPRESSED_FUNCTION_SIZE, so every production deploy
 * failed for ~8h with no hint of which function was too big. This check names
 * the function and its biggest files in the deploy log.
 *
 * Size of a function = files physically inside the .func directory (symlinks
 * followed) + every file listed in .vc-config.json `filePathMap` (the Next.js
 * builder references traced files in place instead of copying them). Each
 * in-function path is counted once.
 *
 * Usage:
 *   node scripts/lib/check-function-bundle-size.js [outputDir=.vercel/output] [--project-root=DIR]
 * Exit: 0 ok (warnings allowed), 1 a function is at/over the fail threshold,
 *       2 no functions dir, or >10% of filePathMap targets missing (wrong root).
 *
 * The BLOCKING check is Vercel's own (VERCEL_ANALYZE_BUILD_OUTPUT=1 on the
 * Build step, fails above 250MB). This script is the advisory early warning
 * that runs after it, so a function creeping toward the limit shows up in the
 * deploy log days before it breaks production.
 * Thresholds (MB = 1024*1024 bytes): warn >= 200MB, fail >= 240MB (limit 250MB).
 * Kill switch: FUNCTION_SIZE_GUARD_DISABLED=true (reports, never fails).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const MB = 1024 * 1024;
const LIMIT_BYTES = 250 * MB;
const WARN_BYTES = 200 * MB;
const FAIL_BYTES = 240 * MB;

function safeStat(p) {
  try { return fs.statSync(p); } catch { return null; }
}

/**
 * Walk a directory following symlinks; calls onFile(relPath, absPath, size).
 * Loop guard tracks the realpaths on the CURRENT branch only, so two
 * destinations that symlink to the same source are both counted (Vercel
 * counts both) while a link back to an ancestor is not followed.
 */
function walkFiles(root, onFile, rel = '', ancestors = new Set()) {
  let real;
  try { real = fs.realpathSync(path.join(root, rel)); } catch { return; }
  if (ancestors.has(real)) return;
  const branch = new Set(ancestors).add(real);
  let entries;
  try { entries = fs.readdirSync(path.join(root, rel)); } catch { return; }
  for (const name of entries) {
    const r = rel ? path.join(rel, name) : name;
    const st = safeStat(path.join(root, r));
    if (!st) continue;
    if (st.isDirectory()) walkFiles(root, onFile, r, branch);
    else if (st.isFile()) onFile(r, path.join(root, r), st.size);
  }
}

/** Find every *.func directory under functionsDir. Returns [{name, dir}] deduped by realpath. */
function findFunctionDirs(functionsDir) {
  const out = [];
  const seen = new Set();
  (function walk(rel) {
    let entries;
    try { entries = fs.readdirSync(path.join(functionsDir, rel)); } catch { return; }
    for (const name of entries) {
      const r = rel ? path.join(rel, name) : name;
      const abs = path.join(functionsDir, r);
      const st = safeStat(abs);
      if (!st || !st.isDirectory()) continue;
      if (name.endsWith('.rsc.func')) continue; // the Vercel CLI's own analysis skips these too
      if (name.endsWith('.func')) {
        let real;
        try { real = fs.realpathSync(abs); } catch { real = abs; }
        if (seen.has(real)) continue; // Next symlinks identical functions to one .func
        seen.add(real);
        out.push({ name: r.slice(0, -'.func'.length), dir: abs });
      } else {
        walk(r);
      }
    }
  })('');
  return out;
}

/** Pure measure of one function. Returns { bytes, files: [{path, bytes}], missing: [] }. */
function measureFunction(funcDir, projectRoot) {
  const files = new Map();
  walkFiles(funcDir, (rel, _abs, size) => files.set(rel.split(path.sep).join('/'), size));
  const missing = [];
  let cfg = null;
  let configError = null;
  const cfgPath = path.join(funcDir, '.vc-config.json');
  if (safeStat(cfgPath)) {
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) { configError = e.message; }
  }
  const map = (cfg && cfg.filePathMap && typeof cfg.filePathMap === 'object') ? cfg.filePathMap : {};
  // Same filter as the Vercel CLI's analysis: only string targets count.
  const entries = Object.entries(map).filter(([k, v]) => typeof k === 'string' && typeof v === 'string');
  const mapped = entries.length;
  for (const [rawInFunc, onDisk] of entries) {
    const inFunc = rawInFunc.replace(/\/+$/, '');
    if (files.has(inFunc)) continue;
    const st = safeStat(path.resolve(projectRoot, onDisk));
    if (!st) { missing.push(onDisk); continue; }
    if (st.isFile()) files.set(inFunc, st.size);
    else if (st.isDirectory()) {
      walkFiles(path.resolve(projectRoot, onDisk), (rel, _a, size) => {
        const key = `${inFunc}/${rel.split(path.sep).join('/')}`;
        if (!files.has(key)) files.set(key, size);
      });
    }
  }
  let bytes = 0;
  for (const s of files.values()) bytes += s;
  const sorted = [...files.entries()].map(([p, b]) => ({ path: p, bytes: b })).sort((a, b) => b.bytes - a.bytes);
  return { bytes, files: sorted, missing, mapped, configError };
}

/** Top directories (first 2 path segments) by bytes, to show what was traced in. */
function topDirs(files, n = 5) {
  const agg = new Map();
  for (const f of files) {
    const key = f.path.split('/').slice(0, 2).join('/');
    agg.set(key, (agg.get(key) || 0) + f.bytes);
  }
  return [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function classify(bytes, { warnBytes = WARN_BYTES, failBytes = FAIL_BYTES } = {}) {
  if (bytes >= failBytes) return 'fail';
  if (bytes >= warnBytes) return 'warn';
  return 'ok';
}

/** Pure: measure all functions in outputDir. */
// filePathMap paths are relative to the repo root vercel build ran in. If most of
// them do not resolve, the root is wrong and every function would measure as a
// few KB and pass: the guard must not fail open that way.
const MAX_MISSING_FRACTION = 0.1;

function checkOutput(outputDir, { projectRoot = process.cwd(), warnBytes = WARN_BYTES, failBytes = FAIL_BYTES } = {}) {
  const functionsDir = path.join(outputDir, 'functions');
  const root = projectRoot;
  const funcs = findFunctionDirs(functionsDir).map((f) => {
    const m = measureFunction(f.dir, root);
    return { name: f.name, ...m, level: classify(m.bytes, { warnBytes, failBytes }) };
  });
  funcs.sort((a, b) => b.bytes - a.bytes);
  const mappedTotal = funcs.reduce((n, f) => n + f.mapped, 0);
  const missingTotal = funcs.reduce((n, f) => n + f.missing.length, 0);
  const rootLooksWrong = mappedTotal > 0 && missingTotal / mappedTotal > MAX_MISSING_FRACTION;
  return { functionsDir, funcs, mappedTotal, missingTotal, rootLooksWrong, failed: funcs.filter((f) => f.level === 'fail'), warned: funcs.filter((f) => f.level === 'warn') };
}

const fmt = (b) => `${(b / MB).toFixed(1)}MB`;

function main(argv) {
  const args = argv.slice(2);
  const outputDir = path.resolve(args.find((a) => !a.startsWith('--')) || '.vercel/output');
  const rootArg = args.find((a) => a.startsWith('--project-root='));
  const projectRoot = rootArg ? path.resolve(rootArg.split('=')[1]) : process.cwd();
  if (!safeStat(path.join(outputDir, 'functions'))) {
    console.error(`::error::no functions directory at ${path.join(outputDir, 'functions')} (did vercel build run?)`);
    return 2;
  }
  const res = checkOutput(outputDir, { projectRoot });
  console.log(`Function bundle sizes (uncompressed; Vercel limit ${fmt(LIMIT_BYTES)}, warn ${fmt(WARN_BYTES)}, fail ${fmt(FAIL_BYTES)}):`);
  console.log(`  ${res.funcs.length} functions measured`);
  for (const f of res.funcs.slice(0, 10)) console.log(`  ${fmt(f.bytes).padStart(9)}  ${f.name}`);
  for (const f of [...res.failed, ...res.warned]) {
    const tag = f.level === 'fail' ? 'error' : 'warning';
    console.log(`::${tag}::function ${f.name} is ${fmt(f.bytes)} uncompressed (Vercel limit ${fmt(LIMIT_BYTES)}). Largest traced dirs: ${topDirs(f.files).map(([d, b]) => `${d} ${fmt(b)}`).join(', ')}. Fix the import that pulls them in, or add them to next.config.js outputFileTracingExcludes.`);
  }
  if (res.rootLooksWrong) {
    console.error(`::error::${res.missingTotal}/${res.mappedTotal} .vc-config.json filePathMap entries are missing under ${projectRoot}; sizes would be undercounted. Run from the directory vercel build ran in, or pass --project-root.`);
    return 2;
  }
  for (const f of res.funcs) {
    if (f.configError) console.log(`::warning::function ${f.name}: unreadable .vc-config.json (${f.configError}); its traced files were not counted`);
    if (f.missing.length) console.log(`  note: ${f.name}: ${f.missing.length}/${f.mapped} filePathMap entries not found on disk (not counted), e.g. ${f.missing.slice(0, 3).join(', ')}`);
  }
  if (res.failed.length === 0) { console.log('OK: no function near the size limit'); return 0; }
  if (process.env.FUNCTION_SIZE_GUARD_DISABLED === 'true') {
    console.log('::warning::FUNCTION_SIZE_GUARD_DISABLED=true, not failing');
    return 0;
  }
  return 1;
}

module.exports = { checkOutput, measureFunction, findFunctionDirs, classify, topDirs, LIMIT_BYTES, WARN_BYTES, FAIL_BYTES };

if (require.main === module) process.exit(main(process.argv));
