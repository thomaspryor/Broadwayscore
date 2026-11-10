#!/usr/bin/env node
'use strict';
/**
 * Stale-tree revert detector (BRO-7078 incident, 2026-11-07).
 *
 * A session that builds a commit from a stale working tree produces a commit
 * whose files equal OLDER versions of those files: every change landed on
 * main since the tree went stale is silently reverted. land/bro-7078-fixups
 * (810c4c3a8) did this to 112 files (-7688 lines); it was stopped only because
 * unrelated data files happened to conflict during the land rebase. A clean
 * rebase would have landed it, with tsc/tests green because the reverted tests
 * went too.
 *
 * Signature: for a file the commit MODIFIES, the commit's blob is byte-equal to
 * a blob that file had at some earlier commit in the parent's history, and is
 * not the parent's own blob. Ordinary edits essentially never recreate a past
 * blob exactly; an intentional `git revert` does, so commits whose subject
 * starts with "Revert" are exempt.
 *
 * Pure part: classifyCommit() decides from blob ids alone (tested).
 * I/O part: scanRange() reads git. CLI: node scripts/lib/stale-tree-revert.js
 *   --base <sha> [--tip HEAD] [--depth 60] [--min-files 3] [--json]
 * Exit 0 always unless --strict (then exit 1 on a flagged commit).
 */
const { execFileSync } = require('child_process');

const DEFAULT_DEPTH = 60;      // earlier versions of each file to compare against
const DEFAULT_MIN_FILES = 3;   // restored files in ONE commit before it is flagged

function isIntentionalRevert(subject) {
  return /^revert\b/i.test(String(subject || '').trim());
}

/**
 * @param {object} c
 * @param {string} c.subject commit subject
 * @param {Array<{path:string, newBlob:string, parentBlob:string, history:string[]}>} c.files
 *   modified files: blob in the commit, blob in its parent, earlier blobs (parent history, newest first)
 * @param {number} [minFiles]
 */
function classifyCommit({ subject, files }, minFiles = DEFAULT_MIN_FILES) {
  const restored = [];
  for (const f of files || []) {
    if (!f || !f.newBlob || f.newBlob === f.parentBlob) continue;
    if ((f.history || []).some((b) => b === f.newBlob)) restored.push(f.path);
  }
  const exempt = isIntentionalRevert(subject);
  return { restored, flagged: !exempt && restored.length >= minFiles, exempt };
}

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
}

function blobAt(rev, path) {
  try { return git(['rev-parse', `${rev}:${path}`], { stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

/** Earlier blobs of `path` reachable from `rev` (excluding rev's own), newest first. */
function historyBlobs(rev, path, depth) {
  let out = '';
  try {
    out = git(['log', `-n${depth + 1}`, '--format=', '--raw', '--no-abbrev', '--no-renames', rev, '--', path],
      { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return []; }
  const blobs = [];
  for (const line of out.split('\n')) {
    // ":100644 100644 <old> <new> M\tpath"
    const m = line.match(/^:\d+ \d+ ([0-9a-f]{40}) ([0-9a-f]{40}) /);
    if (m) { blobs.push(m[2]); blobs.push(m[1]); }
  }
  return blobs;
}

// Stop reading a commit once this many restored files are found: the verdict
// is already decided and a 100+ file stale commit otherwise costs ~1 min.
const STOP_AFTER_RESTORED = 12;

function readCommit(sha, depth) {
  const subject = git(['log', '-1', '--format=%s', sha]).trim();
  const parent = git(['rev-parse', `${sha}^`]).trim();
  const names = git(['diff-tree', '--no-commit-id', '-r', '--no-renames', '--diff-filter=M', '--name-only', parent, sha])
    .split('\n').filter(Boolean);
  const files = [];
  let found = 0;
  for (const path of names) {
    const parentBlob = blobAt(parent, path);
    const newBlob = blobAt(sha, path);
    const hist = historyBlobs(parent, path, depth).filter((b) => b !== parentBlob);
    files.push({ path, newBlob, parentBlob, history: hist });
    if (newBlob && newBlob !== parentBlob && hist.includes(newBlob) && ++found >= STOP_AFTER_RESTORED) break;
  }
  return { sha, subject, files, truncated: files.length < names.length };
}

function scanRange({ base, tip = 'HEAD', depth = DEFAULT_DEPTH, minFiles = DEFAULT_MIN_FILES }) {
  const shas = git(['rev-list', '--no-merges', '--reverse', `${base}..${tip}`]).split('\n').filter(Boolean);
  return shas.map((sha) => {
    const c = readCommit(sha, depth);
    return { sha, subject: c.subject, modified: c.files.length, truncated: c.truncated, ...classifyCommit(c, minFiles) };
  });
}

if (require.main === module) {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const base = arg('--base');
  if (!base) { console.error('usage: stale-tree-revert.js --base <sha> [--tip HEAD] [--depth N] [--min-files N] [--json] [--strict]'); process.exit(2); }
  const res = scanRange({ base, tip: arg('--tip', 'HEAD'), depth: Number(arg('--depth', DEFAULT_DEPTH)), minFiles: Number(arg('--min-files', DEFAULT_MIN_FILES)) });
  if (a.includes('--json')) console.log(JSON.stringify(res, null, 2));
  let bad = 0;
  for (const r of res) {
    if (r.flagged) {
      bad++;
      console.log(`::warning::stale-tree revert: ${r.sha.slice(0, 10)} "${r.subject}" puts back an OLDER version of ${r.truncated ? "at least " : ""}${r.restored.length} file(s) (e.g. ${r.restored.slice(0, 5).join(', ')}). It was likely built from a stale checkout and would undo work already on main. Rebuild the commit on a fresh origin/main.`);
    } else if (!a.includes('--json')) {
      console.log(`ok ${r.sha.slice(0, 10)} restored=${r.restored.length}${r.exempt ? ' (intentional revert)' : ''} ${r.subject}`);
    }
  }
  process.exit(bad && a.includes('--strict') ? 1 : 0);
}

module.exports = { classifyCommit, isIntentionalRevert, scanRange, DEFAULT_DEPTH, DEFAULT_MIN_FILES };
