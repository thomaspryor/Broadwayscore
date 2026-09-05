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
const {
  findStrandedReviewedBranches,
  hasUsableVerdicts,
  sweepIsTrustworthy,
} = require('./lib/stranded-reviewed-branches');

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

// Refresh origin/main first. A stale remote ref cuts both ways: it reports landed
// work as stranded (noise), and after a remote history rewrite it can report
// stranded work as landed (a false all-clear). So a fetch failure invalidates the
// whole run rather than merely warning.
let fetchOk = true;
try {
  git(['fetch', 'origin', 'main:refs/remotes/origin/main', '--force', '-q']);
} catch (e) {
  fetchOk = false;
  console.error('ERROR: could not refresh origin/main — ' + e.message);
}

const worktreePaths = git(['worktree', 'list', '--porcelain'])
  .split('\n')
  .filter((l) => l.startsWith('worktree '))
  .map((l) => l.slice('worktree '.length))
  .filter((p) => path.resolve(p) !== REPO);

// Every per-worktree failure is COUNTED, not silently swallowed. A skip is an
// unmeasured worktree, and an unmeasured worktree can hide exactly the stranded
// work this reports on, so skips invalidate an all-clear (see sweepIsTrustworthy).
const branches = [];
const skippedDetail = [];
function skip(wt, why) { skippedDetail.push(path.basename(wt) + ': ' + why); }

for (const wt of worktreePaths) {
  if (!fs.existsSync(wt)) { skip(wt, 'worktree directory is gone'); continue; }
  const branch = gitQuiet(['branch', '--show-current'], wt);
  if (branch === null) { skip(wt, 'git metadata unreadable'); continue; }
  // A detached HEAD is a real state, not a failure: there is no branch to match
  // against the verdict ledger, so it is genuinely out of scope rather than
  // unmeasured. Counting it as a skip would make every run permanently untrusted.
  if (branch === '') continue;

  // `git cherry` marks a commit '-' when an equivalent patch is ALREADY upstream
  // and '+' when it is not, so counting only '+' stops reporting a REBASED or
  // CHERRY-PICKED branch once its content has landed. `rev-list --count` cannot
  // tell, because it compares commit identity rather than content.
  //
  // It does NOT solve squash merges, and an earlier comment here wrongly claimed
  // it did (caught in review): a squash collapses N commits into one whose
  // patch-id matches none of the originals, so a squash-merged branch still
  // reports as stranded. That residual noise is real and is why --gate is opt-in
  // rather than wired into any push path.
  const cherry = gitQuiet(['cherry', 'origin/main', 'HEAD'], wt);
  if (cherry === null) { skip(wt, 'could not compare against origin/main'); continue; }
  const ahead = cherry === '' ? 0 : cherry.split('\n').filter((l) => l.startsWith('+')).length;

  const status = gitQuiet(['status', '--porcelain'], wt);
  const dirty = status === null ? 0 : status.split('\n').filter((l) => l && !l.startsWith('??')).length;
  const lastCommitDate = gitQuiet(['log', '-1', '--format=%ad', '--date=short'], wt);
  branches.push({ branch, ahead, dirty, lastCommitDate });
}

// The verdict ledger lives in the MAIN checkout's .claude/, not in a worktree's.
// Resolving it relative to __dirname reports 0-at-risk whenever this runs from a
// worktree — a false all-clear, which is the failure mode this script exists to
// prevent. --git-common-dir points at the shared .git for every worktree, so its
// parent is always the main checkout.
function mainCheckoutRoot() {
  // A bare repo has no working tree, so there is no .claude/ beside it and the
  // parent of the git dir means nothing. Reject rather than guess.
  const bare = gitQuiet(['rev-parse', '--is-bare-repository']);
  if (bare === 'true') {
    console.error('ERROR: this is a bare repository; there is no main working tree to read the verdict ledger from.');
    process.exit(2);
  }
  const common = gitQuiet(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  // --path-format needs git 2.31+. Older git prints nothing (the flag errors), and
  // silently falling back to REPO would resolve the ledger inside a WORKTREE, which
  // is the original bug. Refuse instead of quietly reading the wrong path.
  if (!common || !path.isAbsolute(common)) {
    console.error('ERROR: could not resolve the main checkout via --git-common-dir '
      + '(git 2.31+ required). Refusing to guess the verdict ledger location.');
    process.exit(2);
  }
  return path.dirname(common);
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

// The SHARED MAIN CHECKOUT is the highest-risk location of all and was missing
// from the first version of this sweep (caught in review). Both incidents that
// motivated this script — the BRO-2821 venue-token commits and the BRO-2828
// opaque-URL commits on 2026-09-05 — were commits sitting on the shared local
// main, already merged, simply never pushed. A concurrent `reset --hard
// origin/main` destroys those. It is reported separately rather than folded into
// the branch table, because the verdict ledger carries hundreds of entries for
// branch "main" and matching against them would say nothing useful.
const mainRoot = mainCheckoutRoot();
const mainAhead = Number(gitQuiet(['rev-list', '--count', 'origin/main..HEAD'], mainRoot));
const mainUnpushed = Number.isFinite(mainAhead) ? mainAhead : null;

if (JSON_OUT) {
  console.log(JSON.stringify({ ...out, mainCheckoutUnpushed: mainUnpushed }, null, 2));
} else {
  if (mainUnpushed === null) {
    console.log('WARNING: could not measure unpushed commits on the shared main checkout.');
  } else if (mainUnpushed > 0) {
    console.log('UNPUSHED ON THE SHARED MAIN CHECKOUT: ' + mainUnpushed + ' commit(s) at '
      + mainRoot + ' are not on origin/main.');
    console.log('  This is the highest-risk case: another session\'s reset --hard origin/main '
      + 'destroys them. Push with scripts/lib/push-with-retry.sh.');
    console.log('');
  }
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

// An all-clear is only meaningful if the sweep actually measured everything.
const trust = sweepIsTrustworthy({ scanned: branches.length, skipped: skippedDetail.length, fetchOk });
if (!trust.trustworthy) {
  console.error('');
  console.error('UNTRUSTWORTHY SWEEP: ' + trust.reason);
  for (const d of skippedDetail) console.error('  skipped: ' + d);
  console.error('Exiting 2. A clean report from an incomplete sweep is exactly the false '
    + 'all-clear this check exists to prevent.');
  process.exit(2);
}

if (GATE && out.reviewed.length > 0) process.exit(1);
