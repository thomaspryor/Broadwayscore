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

const { hasHelpFlag } = require('./lib/cli-help');

const REPO = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);

// BRO-2878: what counts as CODE for the docs-only signal. Deliberately narrow — a
// branch whose live diff touches none of these is a handoff doc or an audit snapshot
// left behind after its code landed, which is what STATE.md-only branches turned out
// to be. Only ever used to LABEL a row; nothing is auto-landed or auto-deleted.
const IS_CODE_FILE = /\.(js|mjs|cjs|jsx|ts|tsx|mts|cts|sh|bash|py|yml|yaml|css|scss|sql|html|plist)$/i;

// Print usage BEFORE any real work. This script fetches from origin and shells
// out once per worktree, so --help must not trigger a network round trip or a
// 40-worktree sweep (task #498 convention).
if (hasHelpFlag(argv)) {
  console.log(`audit-stranded-reviewed-branches.js — report branches whose work PASSED review
but never landed on origin/main, plus unpushed commits on the shared main checkout.

Usage:
  node scripts/audit-stranded-reviewed-branches.js [--gate] [--json]

  (no flags)  Human-readable report. Always exits 0 when the sweep is trustworthy.
  --gate      Exit 1 when review-passed work is stranded. For scheduled checks.
  --json      Machine-readable output.
  --precise   Use 'git cherry' patch-ids so REBASED and CHERRY-PICKED branches
              stop reporting once their content has landed. Costs minutes on a
              loaded machine, so it is off by default; the default over-reports
              rebased work rather than risking a false all-clear.

Exit codes:
  0  sweep complete and trustworthy
  1  --gate only: stranded review-passed work exists
  2  the sweep could NOT be trusted (fetch failed, a worktree could not be
     classified, no usable verdict ledger, bare repo, or git older than 2.31).
     Exit 2 never means "clean" — it means the run proved nothing.

Report only: it never lands, deletes or rewrites anything. Squash-merged branches
keep reporting until deleted, because a squash's patch-id matches none of the
originals; that is why --gate is opt-in rather than wired into a push path.`);
  process.exit(0);
}

const GATE = argv.includes('--gate');
const JSON_OUT = argv.includes('--json');
// `git cherry` hashes patch-ids, which across ~40 worktrees on a loaded machine
// took over two minutes — measured, not guessed. It only removes noise from
// REBASED or CHERRY-PICKED branches (never squashed ones), so it is not worth
// paying by default. Off: fast rev-list identity, which over-reports rebased work.
// The error direction of the default is toward reporting too much, never toward a
// false all-clear.
const PRECISE = argv.includes('--precise');

// Every git call is time-bounded. `git cherry` computes patch-ids, which on a
// branch with tens of commits is far from instant, and 40 unbounded calls made the
// whole sweep exceed two minutes. A hang must not wedge a scheduled check.
const GIT_TIMEOUT_MS = 20000;

function git(args, cwd = REPO) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', maxBuffer: 1 << 26, timeout: GIT_TIMEOUT_MS,
  }).trim();
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

// Resolve the main checkout ONCE. Excluding only REPO would leave the shared main
// checkout inside the sweep whenever this runs from a linked worktree, so it would
// be counted both in the branch table and in the dedicated main report (caught in
// review). Exclude the real main root, not merely the current directory.
const MAIN_ROOT = mainCheckoutRoot();

const worktreePaths = git(['worktree', 'list', '--porcelain'])
  .split('\n')
  .filter((l) => l.startsWith('worktree '))
  .map((l) => l.slice('worktree '.length))
  .filter((p) => path.resolve(p) !== REPO && path.resolve(p) !== MAIN_ROOT);

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
  // Cheap prefilter first: rev-list is a graph walk, cherry is patch-id hashing.
  // Most worktrees are fully landed, and for those rev-list settles it for free.
  const revCount = gitQuiet(['rev-list', '--count', 'origin/main..HEAD'], wt);
  if (revCount === null) { skip(wt, 'could not compare against origin/main'); continue; }
  const revAhead = Number(revCount);
  if (!Number.isFinite(revAhead)) { skip(wt, 'unreadable commit count'); continue; }

  let ahead = revAhead;
  if (revAhead > 0 && PRECISE) {
    const cherry = gitQuiet(['cherry', 'origin/main', 'HEAD'], wt);
    // On timeout or failure, fall back to the rev-list count. That over-reports
    // rebased work rather than under-reporting stranded work, which is the safe
    // direction for a check whose whole purpose is to avoid a false all-clear.
    if (cherry !== null) {
      ahead = cherry === '' ? 0 : cherry.split('\n').filter((l) => l.startsWith('+')).length;
    }
  }

  const status = gitQuiet(['status', '--porcelain'], wt);
  const dirty = status === null ? 0 : status.split('\n').filter((l) => l && !l.startsWith('??')).length;
  const lastCommitDate = gitQuiet(['log', '-1', '--format=%ad', '--date=short'], wt);

  // BRO-2878: measure what is ACTUALLY still outstanding, not what the verdict said
  // when it was written. A branch whose code has since landed keeps its old verdict,
  // so reporting gatedLines as "work at risk" overstates the exposure. --numstat over
  // the three-dot range gives added+deleted per file against the merge base.
  // Left null on any failure: an unmeasured branch must not read as an empty one.
  let liveDiffLines = null;
  let liveOtherLines = null;
  let liveCodeFiles = null;
  if (ahead > 0) {
    const numstat = gitQuiet(['diff', '--numstat', 'origin/main...HEAD'], wt);
    if (numstat !== null) {
      liveDiffLines = 0;
      liveOtherLines = 0;
      liveCodeFiles = 0;
      for (const line of numstat.split('\n')) {
        if (!line) continue;
        const [addRaw, delRaw, file] = line.split('\t');
        if (!file) continue;
        if (!IS_CODE_FILE.test(file)) {
          // Counted separately, never folded into the code total. Without this the
          // docs-only signal was unreachable: lines only accrued for code files, so
          // liveCodeFiles===0 forced liveDiffLines===0 and the branch that motivated
          // this change (job/1853-mta72xcr, live diff = one STATE.md) was mislabelled
          // "probably already landed" — the label meant for landed CODE.
          const a = Number(addRaw); const d = Number(delRaw);
          if (Number.isFinite(a)) liveOtherLines += a;
          if (Number.isFinite(d)) liveOtherLines += d;
          continue;
        }
        // Count lines from CODE files ONLY. Counting every file made this figure
        // meaningless the first time it ran for real: job/linear-BRO-257-mtag4t59
        // reported 53,189 "lines of code still outstanding" when almost all of it was
        // regenerated data and fixture JSON, against a 260-line review verdict. A
        // headline dominated by data churn is worse than the stale number it replaced.
        // '-' marks a binary file: it counts as a changed file, never as lines.
        const add = Number(addRaw); const del = Number(delRaw);
        if (Number.isFinite(add)) liveDiffLines += add;
        if (Number.isFinite(del)) liveDiffLines += del;
        liveCodeFiles++;
      }
    }
  }
  branches.push({ branch, ahead, dirty, lastCommitDate, liveDiffLines, liveOtherLines, liveCodeFiles });
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
const ledger = path.join(MAIN_ROOT, '.claude', 'review-verdicts.jsonl');
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
// gitQuiet returns null on failure, and Number(null) is 0 — so coercing first
// would turn "could not measure" into "zero unpushed", a false all-clear on the
// highest-risk location in the repo. Caught in review. Check for null FIRST.
const mainAheadRaw = gitQuiet(['rev-list', '--count', 'origin/main..HEAD'], MAIN_ROOT);
const mainAheadNum = mainAheadRaw === null ? NaN : Number(mainAheadRaw);
const mainUnpushed = Number.isFinite(mainAheadNum) ? mainAheadNum : null;

if (JSON_OUT) {
  console.log(JSON.stringify({ ...out, mainCheckoutUnpushed: mainUnpushed }, null, 2));
} else {
  if (mainUnpushed === null) {
    console.log('WARNING: could not measure unpushed commits on the shared main checkout.');
  } else if (mainUnpushed > 0) {
    console.log('UNPUSHED ON THE SHARED MAIN CHECKOUT: ' + mainUnpushed + ' commit(s) at '
      + MAIN_ROOT + ' are not on origin/main.');
    console.log('  This is the highest-risk case: another session\'s reset --hard origin/main '
      + 'destroys them. Push with scripts/lib/push-with-retry.sh.');
    console.log('');
  }
  console.log('Stranded-reviewed-branch sweep: ' + branches.length + ' worktree branch(es) scanned, '
    + out.landed + ' fully landed.');
  console.log('');
  // BRO-2878: the headline is the LIVE diff still outstanding. gatedLines is kept
  // beside it, explicitly labelled as the review-time snapshot, because the two
  // diverge badly once a branch's code lands and only a handoff doc trails behind.
  const noCode = out.reviewed.filter((r) => r.probablyAlreadyLanded || r.docsOnly).length;
  console.log('REVIEW-PASSED but NOT on origin/main (' + out.reviewed.length + ', '
    + out.totalLiveDiffLines + ' lines of code still outstanding) — finished work at risk:');
  if (noCode > 0) {
    console.log('  (' + noCode + ' of them carry NO code in their live diff — docs or an '
      + 'audit snapshot left behind. Excluded from the total above; likely discard, but confirm.)');
  }
  if (!out.reviewed.length) console.log('  none');
  for (const r of out.reviewed) {
    const live = r.liveDiffLines === null ? 'unmeasured' : r.liveDiffLines + ' live';
    const tag = r.probablyAlreadyLanded ? '  [NO LIVE DIFF — probably already landed]'
      : r.docsOnly ? '  [DOCS ONLY — no code files]' : '';
    console.log('  ' + r.branch.padEnd(46) + ' ahead=' + String(r.ahead).padEnd(4)
      + ' dirty=' + String(r.dirty).padEnd(3) + ' last=' + r.lastCommitDate
      + '  <- ' + r.reviewer + ' pass, ' + live + ' (verdict said ' + r.gatedLines + ')' + tag);
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

// An all-clear is only meaningful if the sweep actually measured everything —
// INCLUDING the shared main checkout, which is the highest-risk location. Leaving
// it out of trust accounting would let the script exit 0 while the one place that
// motivated it went unmeasured (caught in review).
if (mainUnpushed === null) skippedDetail.push('the shared main checkout: could not count unpushed commits');
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
