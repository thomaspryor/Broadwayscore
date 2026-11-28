#!/usr/bin/env node
'use strict';
/**
 * rename-crosswire.js (BRO-6594): undo git rename-detection cross-wiring in
 * push-with-retry.sh.
 *
 * In the data repos a file's PATH is its identity (show/outlet--critic.json,
 * _pending/<show>/<outlet>--<hash>.json). git's merge machinery (ort) pairs a
 * deleted file with a DIFFERENT, similar-looking added file as a "rename", and
 * ort ignores both `-X no-renames` and `merge.renames=false` (measured on git
 * 2.43), so no config knob turns it off. Two concurrent poller runs that both
 * drained the same pending stub and each added a different new stub produced
 * a rename/rename(1to2): in run 41013824281 every strategy failed and 29 review
 * files were lost; in the simpler shape the rebase SUCCEEDS and writes our
 * stub's content into the remote's stub path (silent loss of a review).
 *
 * `git diff --no-renames` DOES honour the flag, so the invariant is checked
 * on paths, not on git's rename guesses:
 *   - a path our outgoing commits (base..ours) never touched must end up
 *     exactly as the remote has it;
 *   - a path only we touched (remote base..remote never touched it) must end
 *     up exactly as our pre-resolution head has it;
 *   - a path both sides touched is left to the existing resolution logic.
 * This is precisely what a rename-free three-way merge yields for the
 * one-sided paths, so on any merge that rename detection did not distort it
 * is a no-op.
 *
 * CLI (all refs are commit-ish):
 *   node rename-crosswire.js side   <path> --base B --ours O --remote R
 *        prints remote|ours|both
 *   node rename-crosswire.js repair --base B --ours O --remote R
 *        rewrites the index + worktree for every one-sided path whose HEAD
 *        content differs from its expected side; prints one line per path and
 *        a final `REPAIRED=<n>` line. The caller commits.
 * Fail-open: any git error prints a warning and exits 0 with REPAIRED=0.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');

/** Which side's version a path must end with: 'remote', 'ours' or null (both touched). */
function expectedSource(path, oursTouched, remoteTouched) {
  if (!oursTouched.has(path)) return 'remote';
  if (!remoteTouched.has(path)) return 'ours';
  return null;
}

/**
 * Pure planner. blobs: { head: Map, ours: Map, remote: Map } of path -> blob
 * oid (absent = file does not exist on that side). Returns the paths whose
 * HEAD state differs from their expected side, with the action to take.
 */
function planRepairs({ paths, oursTouched, remoteTouched, blobs }) {
  const out = [];
  for (const path of [...new Set(paths)].sort()) {
    const source = expectedSource(path, oursTouched, remoteTouched);
    if (!source) continue;
    const want = blobs[source].get(path) || null;
    const have = blobs.head.get(path) || null;
    if (want === have) continue;
    out.push({ path, source, action: want ? 'restore' : 'delete' });
  }
  return out;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function changedPaths(a, b) {
  return new Set(git(['diff', '--no-renames', '--no-ext-diff', '--name-only', '-z', a, b]).split('\0').filter(Boolean));
}

function blobsAt(ref, paths) {
  const map = new Map();
  for (let i = 0; i < paths.length; i += 500) {
    const chunk = paths.slice(i, i + 500);
    const raw = git(['ls-tree', '-r', '-z', ref, '--', ...chunk]);
    for (const rec of raw.split('\0')) {
      if (!rec) continue;
      const tab = rec.indexOf('\t');
      const [, type, oid] = rec.slice(0, tab).split(' ');
      if (type === 'blob') map.set(rec.slice(tab + 1), oid);
    }
  }
  return map;
}

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base' || a === '--ours' || a === '--remote') o[a.slice(2)] = argv[++i];
    else o._.push(a);
  }
  return o;
}

function main(argv) {
  const o = parseArgs(argv);
  const cmd = o._[0];
  if (!o.base || !o.ours || !o.remote || !['side', 'repair'].includes(cmd)) {
    console.error('usage: rename-crosswire.js side <path>|repair --base B --ours O --remote R');
    return 2;
  }
  process.chdir(git(['rev-parse', '--show-toplevel']).trim());
  const oursTouched = changedPaths(o.base, o.ours);
  const remoteTouched = changedPaths(o.base, o.remote);
  if (cmd === 'side') {
    const s = expectedSource(o._[1], oursTouched, remoteTouched);
    console.log(s || 'both');
    return 0;
  }
  const paths = [...new Set([...changedPaths(o.remote, 'HEAD'), ...changedPaths(o.ours, 'HEAD')])];
  if (paths.length === 0) { console.log('REPAIRED=0'); return 0; }
  const blobs = { head: blobsAt('HEAD', paths), ours: blobsAt(o.ours, paths), remote: blobsAt(o.remote, paths) };
  const plan = planRepairs({ paths, oursTouched, remoteTouched, blobs });
  for (const r of plan) {
    const ref = r.source === 'ours' ? o.ours : o.remote;
    if (r.action === 'restore') git(['checkout', ref, '--', r.path]);
    else {
      git(['rm', '-q', '-f', '--cached', '--ignore-unmatch', '--', r.path]);
      try { fs.unlinkSync(r.path); } catch { /* already gone */ }
    }
    console.log(`  rename-crosswire: ${r.action} ${r.path} to the ${r.source === 'ours' ? "our run's" : "remote's"} version (git paired it with an unrelated file)`);
  }
  console.log(`REPAIRED=${plan.length}`);
  return 0;
}

module.exports = { expectedSource, planRepairs };

if (require.main === module) {
  let code = 0;
  try { code = main(process.argv.slice(2)); } catch (e) {
    console.log(`::warning::rename-crosswire: skipped (${String(e.message || e).split('\n')[0]})`);
    console.log('REPAIRED=0');
  }
  process.exit(code);
}
