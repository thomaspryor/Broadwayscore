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
 * a blob the file had in main's recent history (read from the merge-base, so a
 * branch undoing its OWN earlier edit does not count) and is not the parent's
 * blob. A file the commit DELETES that main ADDED in that window counts too.
 * Ordinary edits essentially never recreate a past blob exactly. `git revert`
 * and git's "Reapply" do, so subjects starting with Revert/Reapply are exempt.
 *
 * Pure part: classifyCommit() decides from blob ids alone (tested).
 * I/O part: scanRange() reads git. CLI: node scripts/lib/stale-tree-revert.js
 *   --base <sha> [--tip HEAD] [--max-commits 6000] [--min-files 3] [--json] [--strict]
 * --base is any main ref; the range checked is merge-base(base, tip)..tip,
 * the commits as the session wrote them (works even when the rebase conflicts).
 * Exit 0 always unless --strict (then exit 1 on a flagged commit).
 */
const { execFileSync } = require('child_process');

const DEFAULT_HISTORY_COMMITS = 6000; // main commits read once (~1-2 weeks at bot cadence)
const DEFAULT_MIN_FILES = 3;   // restored files in ONE commit before it is flagged
// A stale checkout is days old, not years: bounding the walk keeps a rarely
// edited file from walking the whole history (~0.6s/file unbounded).
const LOOKBACK = '120.days.ago';

function isIntentionalRevert(subject) {
  return /^(revert|reapply)\b/i.test(String(subject || '').trim());
}

/**
 * @param {object} c
 * @param {string} c.subject commit subject
 * @param {Array<{path:string, newBlob:string, parentBlob:string, history:string[]}>} c.files
 *   modified files: blob in the commit, blob in its parent, earlier blobs (parent history, newest first)
 * @param {number} [minFiles]
 */
function classifyCommit({ subject, files, deletedRecentAdds = [] }, minFiles = DEFAULT_MIN_FILES) {
  const restored = [...deletedRecentAdds];
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

/**
 * ONE pass over main's recent history (from the merge-base, never the branch's
 * own commits, so a branch that undoes its own earlier edit is not counted):
 * path -> Set of blobs it had, plus the set of paths ADDED in the window.
 * Bounded by commit count, not by per-file version count (review finding:
 * a per-file path-limited log walks most of the repo for a rarely edited file).
 */
function mainHistory(rev, maxCommits) {
  const blobs = new Map();
  const added = new Set();
  let out = '';
  try {
    out = git(['log', `-n${maxCommits}`, `--since=${LOOKBACK}`, '--no-merges', '--format=', '--raw', '--no-abbrev', '--no-renames', rev],
      { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return { blobs, added }; }
  for (const line of out.split('\n')) {
    // ":100644 100644 <old> <new> M\tpath"
    const m = line.match(/^:\d+ \d+ ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z])\d*\t(.+)$/);
    if (!m) continue;
    const [, oldB, newB, status, path] = m;
    let set = blobs.get(path);
    if (!set) { set = new Set(); blobs.set(path, set); }
    set.add(newB); set.add(oldB);
    if (status === 'A') added.add(path);
  }
  return { blobs, added };
}

function readCommit(sha, hist, mergeBase) {
  const subject = git(['log', '-1', '--format=%s', sha]).trim();
  const parent = git(['rev-parse', `${sha}^`]).trim();
  const lines = git(['diff-tree', '--no-commit-id', '-r', '--no-renames', '--diff-filter=MD', '--name-status', parent, sha])
    .split('\n').filter(Boolean);
  const files = [];
  const deletedRecentAdds = [];
  for (const l of lines) {
    const [status, path] = l.split('\t');
    if (status === 'D') { if (hist.added.has(path)) deletedRecentAdds.push(path); continue; }
    const parentBlob = blobAt(parent, path);
    // The merge-base version is where the branch started: going back to it is
    // the branch undoing its own edit, not undoing main's later work.
    const startBlob = blobAt(mergeBase, path);
    const set = hist.blobs.get(path);
    const history = set ? [...set].filter((b) => b !== parentBlob && b !== startBlob) : [];
    files.push({ path, newBlob: blobAt(sha, path), parentBlob, history });
  }
  return { sha, subject, files, deletedRecentAdds };
}

function scanRange({ base, tip = 'HEAD', maxCommits = DEFAULT_HISTORY_COMMITS, minFiles = DEFAULT_MIN_FILES }) {
  const mergeBase = git(['merge-base', base, tip]).trim();
  const hist = mainHistory(mergeBase, maxCommits);
  const shas = git(['rev-list', '--no-merges', '--reverse', `${mergeBase}..${tip}`]).split('\n').filter(Boolean);
  return shas.map((sha) => {
    const c = readCommit(sha, hist, mergeBase);
    const r = classifyCommit(c, minFiles);
    return { sha, subject: c.subject, modified: c.files.length, ...r };
  });
}

if (require.main === module) {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const base = arg('--base');
  if (!base) { console.error('usage: stale-tree-revert.js --base <sha> [--tip HEAD] [--max-commits N] [--min-files N] [--json] [--strict]'); process.exit(2); }
  const res = scanRange({ base, tip: arg('--tip', 'HEAD'), maxCommits: Number(arg('--max-commits', DEFAULT_HISTORY_COMMITS)), minFiles: Number(arg('--min-files', DEFAULT_MIN_FILES)) });
  if (a.includes('--json')) console.log(JSON.stringify(res, null, 2));
  let bad = 0;
  for (const r of res) {
    if (r.flagged) {
      bad++;
      console.log(`::warning::stale-tree revert: ${r.sha.slice(0, 10)} "${r.subject}" puts back an OLDER version of ${r.restored.length} file(s) (e.g. ${r.restored.slice(0, 5).join(', ')}). It was likely built from a stale checkout and would undo work already on main. Rebuild the commit on a fresh origin/main.`);
    } else if (!a.includes('--json')) {
      console.log(`ok ${r.sha.slice(0, 10)} restored=${r.restored.length}${r.exempt ? ' (intentional revert)' : ''} ${r.subject}`);
    }
  }
  process.exit(bad && a.includes('--strict') ? 1 : 0);
}

module.exports = { classifyCommit, isIntentionalRevert, scanRange, DEFAULT_HISTORY_COMMITS, DEFAULT_MIN_FILES };
