'use strict';
/**
 * mac-disk-digest.js (BRO-8178): one morning-digest line showing this Mac's
 * free disk, how many worktrees exist (job-* / total) and the three biggest
 * consumers, so worktree growth is visible days before bsc-runner's disk
 * floor starts refusing dispatches (2026-11-23: 59 job worktrees at ~800MB,
 * disk at 3GB, dispatch refused, nothing in the digest said why).
 * The alarm rows stay in disk-space-digest.js; this line is informational.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function fmtGb(kb) {
  const gb = kb / 1024 / 1024;
  return gb >= 10 ? `${Math.round(gb)}GB` : `${gb.toFixed(1)}GB`;
}

/**
 * Pure.
 * @param {{freeGb:number|null, worktrees:{total:number, job:number}, sizes:{label:string, kb:number}[]|null}} o
 */
function macDiskLine({ freeGb, worktrees, sizes }) {
  const free = Number.isFinite(freeGb) ? `${freeGb}GB free` : 'free space unknown';
  const wt = `${worktrees.total} worktrees (${worktrees.job} job)`;
  let top = 'biggest consumers unavailable';
  if (Array.isArray(sizes) && sizes.length) {
    top = `biggest: ${[...sizes].sort((a, b) => b.kb - a.kb).slice(0, 3).map((s) => `${s.label} ${fmtGb(s.kb)}`).join(', ')}`;
  }
  return `Mac disk: ${free}, ${wt}; ${top}.`;
}

function listWorktrees(repo) {
  try {
    const out = execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9)).filter((p) => path.resolve(p) !== path.resolve(repo));
  } catch { return []; }
}

/** I/O. `repos` = main checkouts whose worktrees count. Never throws. */
function collectMacDisk({ repos, home = os.homedir(), duTimeoutMs = 120000 } = {}) {
  let freeGb = null;
  try {
    const df = execFileSync('df', ['-Pk', repos[0]], { encoding: 'utf8', timeout: 10000 });
    const avail = Number(df.trim().split('\n')[1].split(/\s+/)[3]);
    if (Number.isFinite(avail)) freeGb = Math.floor(avail / 1024 / 1024);
  } catch { /* unknown */ }
  const wts = repos.flatMap(listWorktrees).filter((p) => fs.existsSync(p));
  const worktrees = { total: wts.length, job: wts.filter((p) => path.basename(p).startsWith('job-')).length };
  const extras = [
    ['Xcode DerivedData', path.join(home, 'Library/Developer/Xcode/DerivedData')],
    ['Library/Caches', path.join(home, 'Library/Caches')],
  ].filter(([, p]) => fs.existsSync(p));
  let sizes = null;
  const targets = [...wts.map((p) => [path.basename(p), p]), ...extras];
  if (targets.length) {
    let out = '';
    try {
      out = execFileSync('du', ['-sk', ...targets.map(([, p]) => p)], { encoding: 'utf8', timeout: duTimeoutMs, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 });
    } catch (err) {
      out = err && typeof err.stdout === 'string' ? err.stdout : ''; // du exits 1 on an unreadable file but still prints totals
    }
    const byPath = new Map(targets.map(([label, p]) => [p, label]));
    sizes = out.split('\n').map((l) => /^(\d+)\t(.+)$/.exec(l)).filter(Boolean)
      .map((m) => ({ label: byPath.get(m[2]) || path.basename(m[2]), kb: Number(m[1]) }));
    if (!sizes.length) sizes = null;
  }
  return { freeGb, worktrees, sizes };
}

module.exports = { macDiskLine, collectMacDisk };
