'use strict';

// Detect branches whose work PASSED review and then never landed on origin/main.
//
// Why this exists (crown v35, 2026-09-05): a sweep of all 40 worktrees found 26
// branches holding commits unreachable from origin/main, and 13 of those carried
// a passing review verdict — roughly 4,600 gated lines of finished, reviewed code
// stranded, the oldest from 2026-08-20. The same failure mode was caught by hand
// TWICE on that single day (three BRO-2821 venue-token commits and three BRO-2828
// opaque-URL commits, each with a ship-check pass, sitting on the shared local
// checkout unpushed). A concurrent `reset --hard origin/main` has destroyed an
// unpushed commit before, so stranded work is not merely untidy, it is at risk.
//
// The decision logic is kept pure and free of git and filesystem access so it can
// be tested against fixtures (CLAUDE.md rule 15). The CLI wrapper supplies the
// real branch and verdict data.

/**
 * Reduce a verdict ledger to the CURRENT verdict per branch: the latest by ts.
 *
 * An earlier version preferred a pass over a later fail, reasoning that a branch
 * could have failed, been fixed, and passed. Adversarial review (Codex, 2026-09-05)
 * pointed out that this is backwards: if the pass is earlier and the fail is later,
 * the chronology describes work that PASSED and was then REJECTED, so honouring the
 * stale pass reports rejected work as "finished work at risk". The latest verdict is
 * the current one, in both directions.
 *
 * KNOWN LIMITATION, deliberately not solved here: verdicts are keyed by branch NAME,
 * not by reviewed commit SHA, so a pass recorded against one commit still matches
 * after new commits are added to the same branch. This report therefore says "this
 * branch was approved at some point and has not landed", not "every commit on it is
 * approved". That is the right claim for a report whose purpose is to stop finished
 * work being lost; binding verdicts to commit OIDs would be a change to the verdict
 * ledger format, which is out of scope for a read-only audit.
 *
 * @param {Array<{branch?: string, result?: string, ts?: string, reviewer?: string, gatedLines?: number}>} verdicts
 * @returns {Map<string, object>} branch -> current verdict
 */
function bestVerdictByBranch(verdicts) {
  const byBranch = new Map();
  for (const v of verdicts || []) {
    if (!v || typeof v.branch !== 'string' || v.branch === '') continue;
    const prev = byBranch.get(v.branch);
    if (!prev || String(v.ts || '') > String(prev.ts || '')) byBranch.set(v.branch, v);
  }
  return byBranch;
}

/**
 * Classify branches into stranded-reviewed vs stranded-unreviewed.
 *
 * A branch is STRANDED when its caller-supplied `ahead` count is above zero.
 *
 * The caller decides what "ahead" means. The CLI uses `git cherry`, which counts
 * only commits whose patch is not already upstream, so rebased and cherry-picked
 * work correctly stops being reported. Squash merges are NOT covered: a squash
 * collapses N commits into one whose patch-id matches none of the originals, so a
 * squash-merged branch keeps reporting until it is deleted. That residual noise is
 * known and is why the gate mode is opt-in. An earlier comment here claimed the
 * opposite behaviour and was wrong; it was corrected after review.
 *
 * @param {Array<{branch: string, ahead: number, dirty?: number, lastCommitDate?: string}>} branches
 * @param {Array<object>} verdicts - raw verdict ledger entries
 * @param {{ignoreBranches?: string[]}} [opts] - branches to exclude (e.g. the caller's own live branch)
 * @returns {{reviewed: object[], unreviewed: object[], landed: number, totalGatedLines: number, totalLiveDiffLines: number}}
 */
function findStrandedReviewedBranches(branches, verdicts, opts = {}) {
  const ignore = new Set(opts.ignoreBranches || []);
  const byBranch = bestVerdictByBranch(verdicts);
  const reviewed = [];
  const unreviewed = [];
  let landed = 0;
  let totalGatedLines = 0;
  let totalLiveDiffLines = 0;

  for (const b of branches || []) {
    if (!b || typeof b.branch !== 'string' || b.branch === '') continue;
    if (ignore.has(b.branch)) continue;
    // Guard against a non-numeric or negative ahead count rather than trusting it.
    const ahead = Number(b.ahead);
    if (!Number.isFinite(ahead) || ahead <= 0) { landed++; continue; }

    const v = byBranch.get(b.branch);
    const row = {
      branch: b.branch,
      ahead,
      dirty: Number(b.dirty) || 0,
      lastCommitDate: b.lastCommitDate || null,
    };
    // BRO-2878: liveDiffLines is the branch's CURRENT diff against origin/main.
    // gatedLines is a SNAPSHOT taken when the branch was reviewed and can be wildly
    // larger, because a branch whose code has since landed still carries its old
    // verdict. Reporting the snapshot as "work at risk" overstated the real figure by
    // about 30% on 2026-09-05: two of twelve branches were billed 652 and 726 gated
    // lines while their entire remaining diff was a STATE.md handoff doc. That pushes
    // a reader toward merging branches whose code already landed, which is how a stale
    // branch reintroduces reverted work. Null means the caller could not measure it;
    // it is NOT treated as zero, because an unmeasured branch is not a safe branch.
    const liveDiffLines = Number.isFinite(Number(b.liveDiffLines)) && Number(b.liveDiffLines) >= 0
      ? Number(b.liveDiffLines)
      : null;
    row.liveDiffLines = liveDiffLines;
    // A branch whose live diff touches no code file is almost always a handoff doc or
    // an audit snapshot left behind after its code landed. Flagged, never auto-acted
    // on: land-or-discard still needs a human.
    row.liveCodeFiles = Number.isFinite(Number(b.liveCodeFiles)) && Number(b.liveCodeFiles) >= 0
      ? Number(b.liveCodeFiles)
      : null;
    row.probablyAlreadyLanded = liveDiffLines === 0;
    row.docsOnly = row.liveCodeFiles === 0 && liveDiffLines !== null && liveDiffLines > 0;

    if (v && v.result === 'pass') {
      row.reviewer = v.reviewer || 'unknown';
      row.gatedLines = Number(v.gatedLines) || 0;
      row.verdictDate = String(v.ts || '').slice(0, 10) || null;
      totalGatedLines += row.gatedLines;
      // Only branches that still carry code count toward the headline exposure. An
      // unmeasured branch (null) falls back to its verdict figure rather than being
      // silently dropped, so a measurement failure cannot shrink the number.
      if (liveDiffLines === null) totalLiveDiffLines += row.gatedLines;
      else if (row.liveCodeFiles !== 0) totalLiveDiffLines += liveDiffLines;
      reviewed.push(row);
    } else {
      unreviewed.push(row);
    }
  }

  // Oldest first: the longest-stranded work is the most likely to be lost and
  // the hardest to land later, so it is what a human should look at first.
  const byDate = (x, y) => String(x.lastCommitDate || '').localeCompare(String(y.lastCommitDate || ''));
  reviewed.sort(byDate);
  unreviewed.sort(byDate);

  return { reviewed, unreviewed, landed, totalGatedLines, totalLiveDiffLines };
}

/**
 * Can this run distinguish reviewed work from unreviewed work at all?
 *
 * Without at least one parseable verdict carrying a branch, every stranded branch
 * falls into the "no passing verdict" bucket and the report reads "none at risk".
 * That is indistinguishable from a genuinely clean repo, so a caller MUST refuse
 * to report success in that state rather than emitting a false all-clear. This
 * exact false all-clear was produced during development, when the ledger path
 * resolved to a worktree instead of the main checkout: 13 stranded reviewed
 * branches were reported as 0.
 *
 * @param {Array<object>} verdicts
 * @returns {boolean}
 */
function hasUsableVerdicts(verdicts) {
  if (!Array.isArray(verdicts)) return false;
  return verdicts.some((v) => v && typeof v.branch === 'string' && v.branch !== '');
}

/**
 * Decide whether a completed sweep is trustworthy enough to report an all-clear.
 *
 * Added after adversarial review (Codex, 2026-09-05) found the script's own
 * headline failure mode still open: every per-worktree git call was wrapped so a
 * failure became a silent skip. If all ~40 worktrees failed to classify — broken
 * git metadata, a missing origin/main, a deleted directory — the report emitted
 * "0 branches at risk" and exit 0, which is a false all-clear produced by checking
 * nothing. That is the precise shape this whole script exists to detect, so it
 * must not be able to commit it itself.
 *
 * @param {{scanned: number, skipped: number, fetchOk: boolean}} sweep
 * @returns {{trustworthy: boolean, reason: string}}
 */
function sweepIsTrustworthy(sweep) {
  const scanned = Number(sweep && sweep.scanned) || 0;
  const skipped = Number(sweep && sweep.skipped) || 0;
  const fetchOk = !!(sweep && sweep.fetchOk);
  if (!fetchOk) {
    return {
      trustworthy: false,
      reason: 'could not refresh origin/main, so reachability was measured against a possibly stale ref',
    };
  }
  if (scanned === 0) {
    return {
      trustworthy: false,
      reason: 'zero worktree branches were successfully classified, so an empty report proves nothing',
    };
  }
  if (skipped > 0) {
    return {
      trustworthy: false,
      reason: skipped + ' worktree(s) could not be classified, so stranded work may be hiding in them',
    };
  }
  return { trustworthy: true, reason: 'all candidate worktrees classified against a fresh origin/main' };
}

module.exports = {
  bestVerdictByBranch,
  findStrandedReviewedBranches,
  hasUsableVerdicts,
  sweepIsTrustworthy,
};
