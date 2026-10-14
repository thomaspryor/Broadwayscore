#!/usr/bin/env node
/**
 * BRO-4815: let gc-merged-worktrees.sh reclaim landed worktrees whose ONLY
 * dirt is untracked session notes (.wrapup-block.txt, STATE.md, HANDOFF-*.md,
 * rap-N.txt ...). is_safe_dirty() allowlists only data/audit/*, so on
 * 2026-10-06 eight ~1.1GB job worktrees (~9GB) were stranded forever and the
 * disk hit 2.2GB free.
 *
 * The caller has ALREADY established: branch fully landed, not locked, no live
 * lease, no live cwd, not an action-* or detached worktree. This module answers the remaining
 * question — "is every dirty path an untracked, small, quiet, closed regular
 * file we can copy out first?" — and does the copy.
 *
 * CLI (exit 0 = eligible [and salvaged unless --check-only], 1 = not eligible):
 *   worktree-gc-salvage.js --path=<worktree> [--check-only] [--min-age-min=30]
 * One JSON line on stdout: {eligible, reason, files, bytes, dest}.
 * Dry-run and the real run BOTH call this (real: copy mode; dry-run:
 * --check-only) so their predictions cannot drift (BRO-2607).
 *
 * Salvage root: ~/Documents/claude-outputs/worktree-salvage/<UTC date>/.
 * WORKTREE_GC_SALVAGE_DIR overrides it, accepted only under a temp dir (test
 * seam; same posture as WORKTREE_GC_LOCK_DIR).
 *
 * Ignored files (node_modules, symlinked data/) are not inspected: removing a
 * CLEAN worktree already deletes them, so this adds no new exposure.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const DEFAULT_MIN_AGE_MIN = 30;

/** `git status --porcelain -z` -> [{xy, path}]. Rename/copy entries carry a
 *  second NUL field (origin path); it is consumed so it is not misread. */
function parseStatusZ(raw) {
  const parts = String(raw).split('\0');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    const xy = p.slice(0, 2);
    out.push({ xy, path: p.slice(3) });
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') i++;
  }
  return out;
}

/** Pure decision. files: [{rel, size, isSymlink, mtimeMs}] for every entry. */
function evaluateEligibility({ entries, files, nowMs, minAgeMin }) {
  if (!entries.length) return { eligible: false, reason: 'clean-or-unreadable' };
  const tracked = entries.find((e) => e.xy !== '??');
  if (tracked) return { eligible: false, reason: `tracked-change:${tracked.path}` };
  if (!files.length) return { eligible: false, reason: 'no-files' };
  let total = 0;
  let newest = 0;
  for (const f of files) {
    if (f.rel.split('/').includes('..') || path.isAbsolute(f.rel)) return { eligible: false, reason: `unsafe-path:${f.rel}` };
    if (f.isSymlink) return { eligible: false, reason: `symlink:${f.rel}` };
    if (f.size > MAX_FILE_BYTES) return { eligible: false, reason: `file-too-large:${f.rel}` };
    total += f.size;
    newest = Math.max(newest, f.mtimeMs);
  }
  if (total > MAX_TOTAL_BYTES) return { eligible: false, reason: 'total-too-large' };
  if (nowMs - newest < minAgeMin * 60000) return { eligible: false, reason: `recent-activity<${minAgeMin}min` };
  return { eligible: true, reason: 'untracked-only', bytes: total };
}

/** Open handles anywhere under the worktree. Anything but a clean
 *  "nothing open" (lsof exit 1, empty stdout) counts as in-use. */
function hasOpenHandles(dir) {
  const r = spawnSync('lsof', ['+D', dir], { encoding: 'utf8', timeout: 45000 });
  if (r.error || r.signal) return true;
  if (r.status === 1 && !String(r.stdout).trim()) return false;
  return true;
}

function resolveSalvageRoot(env = process.env, home = os.homedir()) {
  const o = env.WORKTREE_GC_SALVAGE_DIR;
  if (o && !o.includes('..') && /^(\/tmp\/|\/private\/tmp\/|\/var\/folders\/|\/private\/var\/folders\/)/.test(o)) return o;
  return path.join(home, 'Documents', 'claude-outputs', 'worktree-salvage');
}

/** Copy to `<root>/<date>/<worktree>--<rel with / -> __>`, never overwriting
 *  (COPYFILE_EXCL; a name clash gets a numeric suffix). Verifies the size. */
function copyOut(wt, rels, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const base = path.basename(wt);
  for (const rel of rels) {
    const flat = `${base}--${rel.split('/').join('__')}`;
    let dest = path.join(destDir, flat);
    for (let n = 1; ; n++) {
      try {
        fs.copyFileSync(path.join(wt, rel), dest, fs.constants.COPYFILE_EXCL);
        break;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        dest = path.join(destDir, `${flat}.${n}`);
      }
    }
    if (fs.statSync(dest).size !== fs.statSync(path.join(wt, rel)).size) throw new Error(`size mismatch copying ${rel}`);
  }
}

function inspect(wt, nowMs, minAgeMin) {
  const st = spawnSync('git', ['-C', wt, 'status', '--porcelain', '-z', '-uall'], { encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
  if (st.error || st.status !== 0) return { verdict: { eligible: false, reason: 'git-status-failed' }, rels: [] };
  const entries = parseStatusZ(st.stdout);
  const files = [];
  for (const e of entries) {
    if (e.xy !== '??') continue;
    try {
      const s = fs.lstatSync(path.join(wt, e.path));
      files.push({ rel: e.path, size: s.size, isSymlink: s.isSymbolicLink() || !s.isFile(), mtimeMs: s.mtimeMs });
    } catch {
      return { verdict: { eligible: false, reason: `unreadable:${e.path}` }, rels: [] };
    }
  }
  return { verdict: evaluateEligibility({ entries, files, nowMs, minAgeMin }), rels: files.map((f) => f.rel) };
}

function salvage(wt, { checkOnly = false, minAgeMin = DEFAULT_MIN_AGE_MIN, nowMs = Date.now(), env = process.env } = {}) {
  const { verdict, rels } = inspect(wt, nowMs, minAgeMin);
  if (!verdict.eligible) return verdict;
  // lsof is the slow check, so it runs only after the cheap ones pass.
  if (hasOpenHandles(wt)) return { eligible: false, reason: 'open-file-handles' };
  const dest = path.join(resolveSalvageRoot(env), new Date(nowMs).toISOString().slice(0, 10));
  const res = { eligible: true, reason: verdict.reason, files: rels.length, bytes: verdict.bytes, dest };
  if (checkOnly) return res;
  try {
    copyOut(wt, rels, dest);
  } catch (e) {
    return { eligible: false, reason: `copy-failed:${e.message}` };
  }
  return res;
}

module.exports = { parseStatusZ, evaluateEligibility, hasOpenHandles, resolveSalvageRoot, salvage, MAX_FILE_BYTES, MAX_TOTAL_BYTES };

if (require.main === module) {
  const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3);
  const wt = arg('path');
  if (!wt) { console.error('usage: worktree-gc-salvage.js --path=<worktree> [--check-only] [--min-age-min=N]'); process.exit(2); }
  const minAgeMin = arg('min-age-min') !== '' ? Number(arg('min-age-min')) : DEFAULT_MIN_AGE_MIN;
  const r = salvage(wt, { checkOnly: process.argv.includes('--check-only'), minAgeMin });
  console.log(JSON.stringify(r));
  process.exit(r.eligible ? 0 : 1);
}
