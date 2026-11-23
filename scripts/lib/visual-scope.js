#!/usr/bin/env node
/**
 * visual-scope.js (BRO-8156): which UI files a visual-qa verdict covered, so the owner is asked once per branch.
 *
 * Owner complaint 2026-11-23 (BRO-8086): asked "yes" for the same UI change again and again, because a visual-qa
 * re-run, a tweak to an approved file, or a typed commit label each restarted the ask. The verdict now records:
 *   uiFiles        the UI files the screenshots covered (committed diff vs origin/main plus dirty UI files)
 *   uiFileHashes   git blob id of each of those files as screenshotted (null = deleted)
 *   scopeFirstAt   when screenshots covering this file set were first written on this branch; carried from the
 *                  previous verdict only when its uiFiles is a superset of the new set (a new file restarts it)
 * All three are outside the contentHash (verdict-hash.mjs HASH_EXCLUDED_TOP_LEVEL_FIELDS).
 *
 * commit-msg uses commitProof(): a UI commit passes when every staged UI file's blob equals the one the passing
 * verdict screenshotted. Content hashes, not mtimes, so checkout/rebase/stash cannot fake or break freshness.
 *
 * CLI: node visual-scope.js commit-proof [--cwd=DIR]   -> exit 0 proof ok, 1 not (reason on stderr)
 *      node visual-scope.js head-current --verdict=P --files=a,b [--cwd=DIR] -> exit 0 when the verdict shows HEAD's blobs
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Same text as visual-approval-durable.js UI_RE and the push gate's UI_PATTERN.
const UI_RE = /^(src\/.*\.(tsx|jsx|css|scss|module\.css)$|tailwind\.config\.|postcss\.config\.)/;

const git = (cwd, args, o = {}) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], ...o }).trim();
const lines = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);

/** UI files in base...HEAD plus dirty/untracked UI files, sorted and unique. Any git error -> []. */
function uiWorkingFiles(cwd, base = 'origin/main') {
  const out = new Set();
  try { for (const f of lines(git(cwd, ['diff', '--name-only', '--no-renames', `${base}...HEAD`]))) if (UI_RE.test(f)) out.add(f); } catch { /* no base */ }
  try {
    for (const l of String(git(cwd, ['status', '--porcelain', '--untracked-files=all'])).split('\n')) {
      if (l.length < 4) continue;
      let f = l.slice(3);
      if (f.includes(' -> ')) f = f.split(' -> ').pop();
      f = f.replace(/^"|"$/g, '');
      if (UI_RE.test(f)) out.add(f);
    }
  } catch { /* not a repo */ }
  return [...out].sort();
}

/** {file: blob id of the working-tree file, or null when it does not exist}. */
function blobHashes(cwd, files) {
  const r = {};
  for (const f of files) {
    const abs = path.join(cwd, f);
    try { r[f] = fs.existsSync(abs) ? git(cwd, ['hash-object', '--', f]) : null; } catch { r[f] = null; }
  }
  return r;
}

/** True when every file in `subset` is in `superset`. */
function covers(superset, subset) {
  const s = new Set(superset || []);
  return (subset || []).every((f) => s.has(f));
}

/** The previous verdict's scopeFirstAt when its file set covers the new one, else `now` (ISO). */
function carryScopeFirstAt(existing, uiFiles, now = new Date().toISOString()) {
  // Only a PASSING earlier run starts the window: a failed run's screenshots were never shown for approval.
  if (existing && existing.overallPass === true && typeof existing.scopeFirstAt === 'string' && Array.isArray(existing.uiFiles)
      && !Number.isNaN(Date.parse(existing.scopeFirstAt)) && covers(existing.uiFiles, uiFiles)) return existing.scopeFirstAt;
  return now;
}

/** True when the verdict on disk must be rewritten even though contentHash is unchanged (its scope metadata moved). */
function scopeMetadataChanged(existing, next) {
  if (!existing) return true;
  return JSON.stringify(existing.uiFiles || null) !== JSON.stringify(next.uiFiles || null)
    || JSON.stringify(existing.uiFileHashes || null) !== JSON.stringify(next.uiFileHashes || null);
}

/** Verdict path for a branch: this checkout first, then the main worktree (same order as the push gate). */
function findVerdictPath(cwd, branch) {
  const cands = [];
  let top = cwd;
  try { top = git(cwd, ['rev-parse', '--show-toplevel']); } catch { /* keep cwd */ }
  cands.push(path.join(top, '.claude', 'visual-qa', branch, 'verdict.json'));
  try {
    const common = path.resolve(top, git(cwd, ['rev-parse', '--git-common-dir']));
    if (path.basename(common) === '.git') cands.push(path.join(path.dirname(common), '.claude', 'visual-qa', branch, 'verdict.json'));
  } catch { /* no common dir */ }
  return cands.find((p) => fs.existsSync(p)) || null;
}

/** Staged blob id per file (null when the file is staged as deleted). */
function stagedBlobs(cwd, files) {
  const r = {};
  for (const f of files) {
    let id = null;
    try { const l = git(cwd, ['ls-files', '-s', '--', f]); id = l ? l.split(/\s+/)[1] : null; } catch { id = null; }
    r[f] = id;
  }
  return r;
}

/**
 * Pure decision: does this verdict prove the staged UI files were screenshotted as they are being committed?
 * @param {object|null} verdict parsed verdict.json
 * @param {Record<string,string|null>} staged file -> staged blob id (null = deleted)
 * @returns {{ok:boolean, why:string}}
 */
function commitProof(verdict, staged) {
  const files = Object.keys(staged || {});
  if (!files.length) return { ok: true, why: 'no UI files staged' };
  if (!verdict) return { ok: false, why: 'no visual-qa verdict for this branch' };
  if (String(verdict.schemaVersion) !== '2') return { ok: false, why: 'verdict is not schema v2' };
  if (verdict.overallPass !== true) return { ok: false, why: 'the latest visual-qa verdict did not pass' };
  const seen = verdict.uiFileHashes && typeof verdict.uiFileHashes === 'object' ? verdict.uiFileHashes : null;
  if (!seen) return { ok: false, why: 'verdict predates file tracking (re-run visual-qa)' };
  // A staged deletion of a file the run never saw has nothing to screenshot (the rename's old path, a removed component).
  const stale = files.filter((f) => !(staged[f] === null && !Object.prototype.hasOwnProperty.call(seen, f))
    && (!Object.prototype.hasOwnProperty.call(seen, f) || seen[f] !== staged[f]));
  if (stale.length) return { ok: false, why: `changed after the last visual-qa run: ${stale.slice(0, 5).join(', ')}` };
  return { ok: true, why: `passing visual-qa verdict covers all ${files.length} staged UI file(s)` };
}

/** HEAD blob id per file (null when the file is not in HEAD). */
function headBlobs(cwd, files) {
  const r = {};
  for (const f of files) { try { r[f] = git(cwd, ['rev-parse', '--verify', '-q', `HEAD:${f}`]) || null; } catch { r[f] = null; } }
  return r;
}

/**
 * Pure decision for the push gate's scope reuse: does the passing verdict show every gated file exactly as HEAD has it?
 * Without this, an old passing verdict plus a later unscreenshotted edit could ride an earlier owner yes.
 */
function headCurrent(verdict, head) {
  const files = Object.keys(head || {});
  if (!verdict || verdict.overallPass !== true) return { ok: false, why: 'no passing verdict' };
  const seen = verdict.uiFileHashes && typeof verdict.uiFileHashes === 'object' ? verdict.uiFileHashes : null;
  if (!seen) return { ok: false, why: 'verdict predates file tracking' };
  const stale = files.filter((f) => !Object.prototype.hasOwnProperty.call(seen, f) || seen[f] !== head[f]);
  if (stale.length) return { ok: false, why: `pushed content differs from the screenshots: ${stale.slice(0, 5).join(', ')}` };
  return { ok: true, why: `verdict screenshotted all ${files.length} file(s) as pushed` };
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const opt = {};
  for (const a of rest) { const m = a.match(/^--([\w-]+)=(.*)$/); if (m) opt[m[1]] = m[2]; }
  const cwd = opt.cwd || process.cwd();
  if (cmd === 'commit-proof') {
    // Only the commit-msg hook's file set: src/(app|components)/**/*.tsx (what it has always gated).
    let files = [];
    try { files = lines(git(cwd, ['diff', '--cached', '--name-only', '--no-renames'])).filter((f) => /^src\/(app|components)\/.*\.tsx$/.test(f)); } catch { files = []; }
    let branch = '';
    try { branch = git(cwd, ['branch', '--show-current']); } catch { branch = ''; }
    let verdict = null;
    const vp = branch ? findVerdictPath(cwd, branch) : null;
    if (vp) { try { verdict = JSON.parse(fs.readFileSync(vp, 'utf8')); } catch { verdict = null; } }
    const r = commitProof(verdict, stagedBlobs(cwd, files));
    console.error(`[visual-scope] ${r.ok ? 'ok' : 'no proof'}: ${r.why}`);
    return r.ok ? 0 : 1;
  }
  if (cmd === 'head-current') {
    const files = String(opt.files || '').split(',').map((x) => x.trim()).filter(Boolean);
    let verdict = null;
    try { verdict = JSON.parse(fs.readFileSync(opt.verdict, 'utf8')); } catch { verdict = null; }
    const r = files.length ? headCurrent(verdict, headBlobs(cwd, files)) : { ok: false, why: 'no files' };
    console.error(`[visual-scope] ${r.ok ? 'current' : 'not current'}: ${r.why}`);
    return r.ok ? 0 : 1;
  }
  console.error('usage: visual-scope.js commit-proof|head-current [--cwd=DIR] [--verdict=PATH --files=a,b]');
  return 2;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { UI_RE, uiWorkingFiles, blobHashes, covers, carryScopeFirstAt, scopeMetadataChanged, findVerdictPath, stagedBlobs, commitProof, headBlobs, headCurrent };
