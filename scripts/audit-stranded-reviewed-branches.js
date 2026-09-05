#!/usr/bin/env node
'use strict';

// Report branches whose work PASSED review and then never landed on origin/main.
//
// Crown v35 measured this by hand on 2026-09-05: of 40 worktrees, 26 held commits
// unreachable from origin/main and 13 of those carried a passing verdict, roughly
// 4,600 gated lines of finished reviewed code, the oldest stranded since
// 2026-08-20. Nothing alerted on any of it. This script is that alert.
//
// REPORT-ONLY by default. It never lands, deletes or rewrites anything: deciding
// whether a stranded branch should be landed or discarded needs a human, since
// some are genuinely superseded. Pass --gate to make it exit non-zero when
// stranded reviewed work exists, for use in a scheduled check.
//
// Decision logic lives in scripts/lib/stranded-reviewed-branches.js and is tested
// against fixtures; this file only gathers inputs and formats output.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { findStrandedReviewedBranches, hasUsableVerdicts } = require('./lib/stranded-reviewed-branches');

const REPO = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const GATE = argv.includes('--gate');
const JSON_OUT = argv.includes('--json');

function git(args, cwd = REPO) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 26 }).trim();
}

function gitQuiet(args, cwd) {
  try { return git(args, cwd); } catch (e) { return null; }
}

// Refresh origin/main first. A stale remote ref would report landed work as
// stranded — the exact false alarm that would train people to ignore this.
try {
  git(['fetch', 'origin', 'main:refs/remotes/origin/main', '--force', '-q']);
} catch (e) {
  console.error('warning: could not fetch origin/main; results may be stale — ' + e.message);
}

const worktreePaths = git(['worktree', 'list', '--porcelain'])
  .split('\n')
  .filter((l) => l.startsWith('worktree '))
  .map((l) => l.slice('worktree '.length))
  .filter((p) => path.resolve(p) !== REPO);

const branches = [];
for (const wt of worktreePaths) {
  if (!fs.existsSync(wt)) continue;
  const branch = gitQuiet(['branch', '--show-current'], wt);
  if (!branch) continue; // detached HEAD
  const ahead = gitQuiet(['rev-list', '--count', 'origin/main..HEAD'], wt);
  if (ahead === null) continue;
  const status = gitQuiet(['status', '--porcelain'], wt) || '';
  const dirty = status.split('\n').filter((l) => l && !l.startsWith('??')).length;
  const lastCommitDate = gitQuiet(['log', '-1', '--format=%ad', '--date=short'], wt);
  branches.push({ branch, ahead: Number(ahead), dirty, lastCommitDate });
}

// The verdict ledger lives in the MAIN checkout's .claude/, not in a worktree's.
// Resolving it relative to __dirname reports 0-at-risk whenever this runs from a
// worktree — a false all-clear, which is the failure mode this script exists to
// prevent. --git-common-dir points at the shared .git for every worktree, so its
// parent is always the main checkout.
function mainCheckoutRoot() {
  const common = gitQuiet(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common) return path.dirname(common);
  return REPO;
}

let verdicts = [];
const ledger = path.join(mainCheckoutRoot(), '.claude', 'review-verdicts.jsonl');
if (fs.existsSync(ledger)) {
  verdicts = fs.readFileSync(ledger, 'utf8').split('\n')
    .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
    .filter(Boolean);
}
// Fail CLOSED on a missing or empty ledger. Without verdicts every stranded
// branch reads as unreviewed and the report says "none at risk", which is
// indistinguishable from genuinely-clean and is precisely how a broken check
// gets trusted for weeks.
if (!hasUsableVerdicts(verdicts)) {
  console.error('ERROR: no usable review verdicts at ' + ledger
    + ' — cannot distinguish reviewed from unreviewed work, so this run proves NOTHING.');
  process.exit(2);
}

// A session running this from its own worktree would otherwise always report
// itself. Exclude the current branch when invoked from inside a worktree.
const selfBranch = gitQuiet(['branch', '--show-current'], process.cwd());
const out = findStrandedReviewedBranches(branches, verdicts, {
  ignoreBranches: selfBranch ? [selfBranch] : [],
});

if (JSON_OUT) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log('Stranded-reviewed-branch sweep: ' + branches.length + ' worktree branch(es) scanned, '
    + out.landed + ' fully landed.');
  console.log('');
  console.log('REVIEW-PASSED but NOT on origin/main (' + out.reviewed.length + ', '
    + out.totalGatedLines + ' gated lines total) — finished work at risk:');
  if (!out.reviewed.length) console.log('  none');
  for (const r of out.reviewed) {
    console.log('  ' + r.branch.padEnd(46) + ' ahead=' + String(r.ahead).padEnd(4)
      + ' dirty=' + String(r.dirty).padEnd(3) + ' last=' + r.lastCommitDate
      + '  <- ' + r.reviewer + ' pass, ' + r.gatedLines + ' gated lines');
  }
  console.log('');
  console.log('Stranded with no passing verdict (' + out.unreviewed.length + ') — likely work-in-progress:');
  if (!out.unreviewed.length) console.log('  none');
  for (const r of out.unreviewed) {
    console.log('  ' + r.branch.padEnd(46) + ' ahead=' + String(r.ahead).padEnd(4)
      + ' dirty=' + String(r.dirty).padEnd(3) + ' last=' + r.lastCommitDate);
  }
  console.log('');
  console.log('Report only. Decide per branch whether to land or discard; some are superseded.');
}

if (GATE && out.reviewed.length > 0) process.exit(1);
