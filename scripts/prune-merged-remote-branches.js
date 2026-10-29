#!/usr/bin/env node
'use strict';

/**
 * prune-merged-remote-branches.js — delete merged throwaway branches on origin (BRO-2975).
 *
 *   node scripts/prune-merged-remote-branches.js            dry run (default)
 *   node scripts/prune-merged-remote-branches.js --apply    delete (at most MAX_DELETES_PER_RUN)
 *
 * Decisions + tests: scripts/lib/remote-branch-prune.js, scripts/gc-merged-worktrees.test.mjs.
 */

const { execFileSync } = require('child_process');
const { decideRemoteBranchPrune, MAX_DELETES_PER_RUN } = require('./lib/remote-branch-prune');

const apply = process.argv.includes('--apply');
const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();

function main() {
  git(['fetch', '-q', 'origin', '+refs/heads/*:refs/remotes/origin/*']);
  const merged = new Set(git(['branch', '-r', '--merged', 'origin/main', '--format=%(refname:short)']).split('\n').filter(Boolean));
  const live = new Set(git(['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('branch ')).map((l) => l.replace('branch refs/heads/', '')));
  const openPrs = new Set();
  try {
    const { runGhWithFallback } = require('./lib/land-retry-on-cancel');
    const repo = process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore';
    JSON.parse(runGhWithFallback([`repos/${repo}/pulls?state=open&per_page=100`], { exec: execFileSync, fallbackToken: process.env.GH_FALLBACK_TOKEN })).forEach((p) => openPrs.add(p.head && p.head.ref));
  } catch (err) {
    console.log(`open PR list unreadable (${String(err.message).split('\n')[0]}): refusing to delete`);
    if (apply) process.exit(1);
  }
  const rows = git(['for-each-ref', '--format=%(refname:short)|%(objectname)|%(committerdate:iso-strict)', 'refs/remotes/origin/']).split('\n').filter(Boolean);
  const candidates = [];
  const keptBy = {};
  for (const row of rows) {
    const [short, tip, date] = row.split('|');
    const branch = short.replace(/^origin\//, '');
    const d = decideRemoteBranchPrune({ branch, mergedIntoMain: merged.has(short), tipCommittedAt: date, openPr: openPrs.has(branch), liveWorktree: live.has(branch) });
    if (d.prune) candidates.push({ branch, tip, date });
    else keptBy[d.reason] = (keptBy[d.reason] || 0) + 1;
  }
  candidates.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const batch = candidates.slice(0, MAX_DELETES_PER_RUN);
  for (const c of batch) console.log(`${apply ? 'DELETE' : 'candidate'} ${c.branch} @${c.tip} (tip ${c.date.slice(0, 10)})`);
  console.log(`${rows.length} remote heads; ${candidates.length} prunable (${batch.length} this run); kept: ${JSON.stringify(keptBy)}`);
  if (!apply) return;
  let failed = 0;
  for (const c of batch) {
    try {
      const now = git(['ls-remote', 'origin', `refs/heads/${c.branch}`]).split(/\s/)[0];
      if (now !== c.tip) { console.log(`${c.branch}: tip moved; kept`); continue; }
      git(['push', 'origin', `--force-with-lease=refs/heads/${c.branch}:${c.tip}`, `:refs/heads/${c.branch}`]);
    } catch (err) { failed += 1; console.log(`::warning::${c.branch}: delete refused (${String(err.message).split('\n')[0]})`); }
  }
  if (failed) process.exitCode = 1;
}

main();
