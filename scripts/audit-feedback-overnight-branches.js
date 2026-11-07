#!/usr/bin/env node
// Disposition audit for the nightly `feedback-overnight` branches in the iOS app repo (BRO-3015).
// Per branch: ancestor of origin/main? else does its diff reverse-apply to origin/main (fix already
// present = superseded), forward-apply cleanly (mergeable), or conflict (needs hand port)?
// Usage: node scripts/audit-feedback-overnight-branches.js [--repo=~/BroadwayScorecard-app] [--json]
'use strict';
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');

const BRANCH_RE = /^(?:origin\/)?worktree-feedback-overnight-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// Accepts `git branch -a` or `--format=%(refname:short)` output. Remote-only branches are kept
// (as origin/<name>); a local branch wins over its remote twin.
function parseBranchList(text) {
  const byBare = new Map();
  for (const l of text.split('\n')) {
    const ref = l.replace(/^[+* ]+/, '').replace(/^remotes\//, '').trim();
    if (!BRANCH_RE.test(ref)) continue;
    const bare = ref.replace(/^origin\//, '');
    if (!byBare.has(bare) || !ref.startsWith('origin/')) byBare.set(bare, ref);
  }
  return [...byBare.values()].sort();
}

// Pure decision. facts: { isAncestor, empty, reverseApplies, forwardApplies }
function classify(f) {
  if (f.isAncestor) return 'merged';
  if (f.empty) return 'empty';
  if (f.reverseApplies) return 'superseded';
  if (f.forwardApplies) return 'mergeable';
  return 'conflicts';
}

// Per-file state: 'present' (main already has this change), 'applies' (clean forward), 'conflict'.
function classifyFile(f) {
  if (f.reverseApplies) return 'present';
  return f.forwardApplies ? 'applies' : 'conflict';
}

function git(repo, args, env) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
}

function auditBranch(repo, branch, base = 'origin/main') {
  const isAncestor = spawnSync('git', ['-C', repo, 'merge-base', '--is-ancestor', branch, base]).status === 0;
  // Diff from the fork point so multi-commit branches are audited in full (root/unrelated: empty tree).
  const mb = spawnSync('git', ['-C', repo, 'merge-base', base, branch], { encoding: 'utf8' });
  const from = mb.status === 0 ? mb.stdout.trim() : EMPTY_TREE;
  const files = git(repo, ['diff', '--name-only', '-M', from, branch]).split('\n').filter(Boolean);
  const empty = files.length === 0;
  let reverseApplies = false;
  let forwardApplies = false;
  const fileStates = {};
  if (!isAncestor && !empty) {
    const patch = git(repo, ['diff', '--binary', from, branch]);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-idx-'));
    const idx = path.join(tmp, 'index');
    const env = { GIT_INDEX_FILE: idx };
    try {
    git(repo, ['read-tree', base], env);
    const tryApply = (extra) =>
      spawnSync('git', ['-C', repo, 'apply', '--cached', '--check', ...extra], { input: patch, env: { ...process.env, ...env } }).status === 0;
    reverseApplies = tryApply(['-R']);
    forwardApplies = tryApply([]);
    for (const file of files) {
      const fp = git(repo, ['diff', '--binary', from, branch, '--', file]);
      const ok = (extra) =>
        spawnSync('git', ['-C', repo, 'apply', '--cached', '--check', ...extra], { input: fp, env: { ...process.env, ...env } }).status === 0;
      fileStates[file] = classifyFile({ reverseApplies: ok(['-R']), forwardApplies: ok([]) });
    }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  return {
    branch,
    date: branch.replace(/^(?:origin\/)?worktree-feedback-overnight-/, ''),
    empty,
    subject: git(repo, ['log', '-1', '--format=%s', branch]).trim(),
    files,
    isAncestor,
    fileStates,
    reverseApplies,
    forwardApplies,
    disposition: classify({ isAncestor, empty, reverseApplies, forwardApplies }),
  };
}

const USAGE = 'Usage: node scripts/audit-feedback-overnight-branches.js [--repo=~/BroadwayScorecard-app] [--json]\nRead-only: classifies feedback-overnight branches vs origin/main (merged/superseded/mergeable/conflicts/empty).';

function main() {
  if (hasHelpFlag(process.argv.slice(2))) return console.log(USAGE);
  const arg = process.argv.find((a) => a.startsWith('--repo='));
  const repo = arg ? arg.slice(7).replace(/^~/, os.homedir()) : path.join(os.homedir(), 'BroadwayScorecard-app');
  const branches = parseBranchList(git(repo, ['branch', '-a', '--format=%(refname:short)']));
  const rows = branches.map((b) => {
    try {
      return auditBranch(repo, b);
    } catch (e) {
      return { branch: b, date: b, files: [], fileStates: {}, subject: '', disposition: 'error', error: e.message.split('\n')[0] };
    }
  });
  if (process.argv.includes('--json')) return console.log(JSON.stringify(rows, null, 2));
  for (const r of rows) console.log(`${r.date}\t${r.disposition}\t${r.files.length} files\t${Object.values(r.fileStates).join(',')}\t${r.subject}`);
  const counts = {};
  for (const r of rows) counts[r.disposition] = (counts[r.disposition] || 0) + 1;
  console.log(JSON.stringify(counts));
}

module.exports = { classifyFile, parseBranchList, classify, auditBranch, BRANCH_RE };
if (require.main === module) main();
