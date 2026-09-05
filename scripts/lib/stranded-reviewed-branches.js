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
 * Reduce a verdict ledger to the best verdict per branch.
 *
 * "Best" deliberately prefers a pass over a later fail. A branch that failed
 * review, was fixed, and passed can legitimately have both, and ordering in the
 * ledger is not guaranteed to reflect that sequence. Preferring the pass keeps a
 * genuinely-approved branch visible rather than silently dropping it; the cost of
 * a false positive here is one line of report output, while the cost of a false
 * negative is losing reviewed work.
 *
 * @param {Array<{branch?: string, result?: string, ts?: string, reviewer?: string, gatedLines?: number}>} verdicts
 * @returns {Map<string, object>} branch -> chosen verdict
 */
function bestVerdictByBranch(verdicts) {
  const byBranch = new Map();
  for (const v of verdicts || []) {
    if (!v || typeof v.branch !== 'string' || v.branch === '') continue;
    const prev = byBranch.get(v.branch);
    if (!prev) { byBranch.set(v.branch, v); continue; }
    const prevPass = prev.result === 'pass';
    const thisPass = v.result === 'pass';
    if (thisPass && !prevPass) { byBranch.set(v.branch, v); continue; }
    if (thisPass === prevPass && String(v.ts || '') > String(prev.ts || '')) {
      byBranch.set(v.branch, v);
    }
  }
  return byBranch;
}

/**
 * Classify branches into stranded-reviewed vs stranded-unreviewed.
 *
 * A branch is STRANDED when it has at least one commit unreachable from
 * origin/main. `ahead` of 0 means every commit is already reachable, which is
 * exactly what a landed branch looks like regardless of how it landed (fast
 * forward, merge commit, squash onto an equivalent tree does NOT count and will
 * show as stranded — that is intentional, since a squash leaves the branch's own
 * commits genuinely unreachable and a human should confirm the content landed).
 *
 * @param {Array<{branch: string, ahead: number, dirty?: number, lastCommitDate?: string}>} branches
 * @param {Array<object>} verdicts - raw verdict ledger entries
 * @param {{ignoreBranches?: string[]}} [opts] - branches to exclude (e.g. the caller's own live branch)
 * @returns {{reviewed: object[], unreviewed: object[], landed: number, totalGatedLines: number}}
 */
function findStrandedReviewedBranches(branches, verdicts, opts = {}) {
  const ignore = new Set(opts.ignoreBranches || []);
  const byBranch = bestVerdictByBranch(verdicts);
  const reviewed = [];
  const unreviewed = [];
  let landed = 0;
  let totalGatedLines = 0;

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
    if (v && v.result === 'pass') {
      row.reviewer = v.reviewer || 'unknown';
      row.gatedLines = Number(v.gatedLines) || 0;
      row.verdictDate = String(v.ts || '').slice(0, 10) || null;
      totalGatedLines += row.gatedLines;
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

  return { reviewed, unreviewed, landed, totalGatedLines };
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

module.exports = { bestVerdictByBranch, findStrandedReviewedBranches, hasUsableVerdicts };
