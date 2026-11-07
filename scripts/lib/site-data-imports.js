'use strict';
/**
 * BRO-4614: the tracked data/*.json files the built site reads from src/.
 *
 * should-deploy-gate.js diffs only SITE_PATHS against the live deployment, and
 * that list never named data/, so a commit that changed e.g. data/tour-schedules.json
 * (committed in this repo, imported by src/lib/data-tour-schedule.ts) looked
 * like bookkeeping and rode the 6h staleness backstop. The gate lists these
 * files as exact paths (a data/ prefix would re-admit the constant
 * data/audit/ bookkeeping churn the gate exists to skip), and a unit test
 * compares that list to scanSiteDataImports() so a new import cannot drift.
 *
 * Core files that live in the private repo are not tracked here (they are
 * covered by the blob-SHA comparison, core-data-blob-meta.js) and drop out
 * because only `git ls-files` paths count.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Bookkeeping dirs: tracked and referenced by src, but rewritten by cron runs
// that never change what the site renders. Deploying on them recreates the
// ~139 builds/day this gate was built to remove.
const EXCLUDED_PREFIXES = ['data/audit/'];
const SRC_FILE_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const DATA_REF_RE = /data\/([\w\-./[\]]+\.json)\b/g;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (SRC_FILE_RE.test(e.name)) out.push(p);
  }
  return out;
}

/** @returns {string[]} sorted repo-relative paths, e.g. 'data/tour-schedules.json' */
function scanSiteDataImports(root = path.join(__dirname, '..', '..')) {
  const tracked = new Set(
    execFileSync('git', ['ls-files', '--', 'data'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n')
      .filter(Boolean),
  );
  const found = new Set();
  for (const file of walk(path.join(root, 'src'))) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
      for (const m of line.matchAll(DATA_REF_RE)) {
        const p = `data/${m[1]}`;
        if (tracked.has(p) && !EXCLUDED_PREFIXES.some((x) => p.startsWith(x))) found.add(p);
      }
    }
  }
  return [...found].sort();
}

module.exports = { scanSiteDataImports, EXCLUDED_PREFIXES };

if (require.main === module) {
  // node scripts/lib/site-data-imports.js  -> the list to paste into SITE_DATA_FILES
  for (const p of scanSiteDataImports()) console.log(`  '${p}',`);
}
