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

const BRANCH_RE = /^worktree-feedback-overnight-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/;

function parseBranchList(text) {
  return [...new Set(text.split('\n').map((l) => l.replace(/^[+* ]+/, '').trim()))].filter((b) => BRANCH_RE.test(b));
}

// Pure decision. facts: { isAncestor, reverseApplies, forwardApplies }
function classify(f) {
  if (f.isAncestor) return 'merged';
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
  const files = git(repo, ['diff', '--name-only', `${branch}~1`, branch]).split('\n').filter(Boolean);
  let reverseApplies = false;
  let forwardApplies = false;
  const fileStates = {};
  if (!isAncestor) {
    const patch = git(repo, ['diff', '--binary', `${branch}~1`, branch]);
    const idx = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fo-idx-')), 'index');
    const env = { GIT_INDEX_FILE: idx };
    git(repo, ['read-tree', base], env);
    const tryApply = (extra) =>
      spawnSync('git', ['-C', repo, 'apply', '--cached', '--check', ...extra], { input: patch, env: { ...process.env, ...env } }).status === 0;
    reverseApplies = tryApply(['-R']);
    forwardApplies = tryApply([]);
    for (const file of files) {
      const fp = git(repo, ['diff', '--binary', `${branch}~1`, branch, '--', file]);
      const ok = (extra) =>
        spawnSync('git', ['-C', repo, 'apply', '--cached', '--check', ...extra], { input: fp, env: { ...process.env, ...env } }).status === 0;
      fileStates[file] = classifyFile({ reverseApplies: ok(['-R']), forwardApplies: ok([]) });
    }
    fs.rmSync(path.dirname(idx), { recursive: true, force: true });
  }
  return {
    branch,
    date: branch.replace('worktree-feedback-overnight-', ''),
    subject: git(repo, ['log', '-1', '--format=%s', branch]).trim(),
    files,
    isAncestor,
    fileStates,
    reverseApplies,
    forwardApplies,
    disposition: classify({ isAncestor, reverseApplies, forwardApplies }),
  };
}

function main() {
  const arg = process.argv.find((a) => a.startsWith('--repo='));
  const repo = arg ? arg.slice(7).replace(/^~/, os.homedir()) : path.join(os.homedir(), 'BroadwayScorecard-app');
  const branches = parseBranchList(git(repo, ['branch', '-a', '--format=%(refname:short)']));
  const rows = branches.map((b) => auditBranch(repo, b));
  if (process.argv.includes('--json')) return console.log(JSON.stringify(rows, null, 2));
  for (const r of rows) console.log(`${r.date}\t${r.disposition}\t${r.files.length} files\t${Object.values(r.fileStates).join(',')}\t${r.subject}`);
  const counts = {};
  for (const r of rows) counts[r.disposition] = (counts[r.disposition] || 0) + 1;
  console.log(JSON.stringify(counts));
}

module.exports = { classifyFile, parseBranchList, classify, auditBranch, BRANCH_RE };
if (require.main === module) main();
