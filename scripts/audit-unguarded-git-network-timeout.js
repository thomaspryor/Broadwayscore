#!/usr/bin/env node
/**
 * BRO-7458: flags spawnSync/execFileSync/execSync git fetch|pull|clone calls that pass a `timeout`
 * but do not go through scripts/lib/git-proc-guard.js (runGit / runGitOrThrow).
 *
 * Why: on timeout node kills only the direct child. The fetch's `git index-pack` is reparented to
 * pid 1 and keeps writing .git/objects/pack/tmp_pack_* (3.4 GB seen 2026-11-18), filling the disk.
 * runGit sweeps and kills the helpers a timed-out network git left reparented to pid 1.
 * A wrapper passing an args variable (`execFileSync('git', args, { timeout })`) is flagged too:
 * it cannot know whether a caller hands it a fetch.
 *
 * Fix a hit: use runGitOrThrow(args, opts) (execFileSync-shaped) or runGit('git', args, opts)
 * (spawnSync-shaped). Reviewed false positive: `git-net-timeout-ok: <reason>` on the line or above.
 *
 * ADVISORY (CLAUDE.md §19): exit 0 always, unless --strict (any hit => exit 1).
 * Usage: node scripts/audit-unguarded-git-network-timeout.js [--strict] [--json]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { exitOnHelp } = require('./lib/cli-help.js');
const { scanFiles } = require('./lib/unguarded-git-network-scan.js');

const ROOT = path.join(__dirname, '..');
const SKIP = /(\.test\.[cm]?[jt]s$|[\\/]node_modules[\\/]|[\\/]tests?[\\/]|git-proc-guard\.js$|unguarded-git-network-scan\.js$|audit-unguarded-git-network-timeout\.js$)/;

function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
    else if (/\.(c?js|mjs|ts)$/.test(e.name) && !SKIP.test(path.relative(ROOT, p))) out.push(p); // relative: a checkout under /tests/ must not skip everything
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const files = walk(path.join(ROOT, 'scripts')).map((p) => ({ file: path.relative(ROOT, p), text: fs.readFileSync(p, 'utf8') }));
  const hits = scanFiles(files);
  if (args.includes('--json')) console.log(JSON.stringify(hits, null, 2));
  else {
    console.log(`unguarded git network calls with a timeout: ${hits.length} (scanned ${files.length} files)`);
    for (const h of hits) console.log(`${process.env.GITHUB_ACTIONS ? '::warning::' : '  '}${h.file}:${h.line} ${h.call}: ${h.snippet}  -> use runGitOrThrow/runGit (scripts/lib/git-proc-guard.js)`);
  }
  process.exit(args.includes('--strict') && hits.length ? 1 : 0);
}

if (require.main === module) {
  exitOnHelp(module);
  main();
}
