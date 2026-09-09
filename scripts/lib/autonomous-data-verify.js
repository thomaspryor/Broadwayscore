/**
 * autonomous-data-verify.js — Tier-2 verifier harness (Sprint 4, S4-T1/T3).
 *
 * Maps a data card class to the concrete, DETERMINISTIC verifier command(s)
 * that must pass before its diff can merge. Unlike Tier 1's checkableDone
 * (LLM-authored, validated against SAFE_CHECK_FORMS), these argvs are chosen
 * by US — the class is a controlled enum (autonomous-eligibility.js
 * classifyDataCard), never card text — so there is no injection surface here.
 *
 * verifierArgvFor() returns argv arrays to run with cwd = the verification
 * root (a directory shaped like this repo's data/ layout — see
 * scripts/lib/autonomous-data-workdir.js). validate-show-venue.js and
 * validate-data.js resolve their data dir from --data-dir (added this sprint)
 * because they hardcode DATA_DIR relative to their own __dirname, which would
 * otherwise always resolve to the live checkout no matter the cwd.
 * verify-review-recovery.js already resolves from process.cwd() (a deliberate
 * design noted in its own header — "works from the main repo even when the
 * file lives in a worktree") so it only needs the right cwd, no new flag.
 */

'use strict';

const path = require('path');

const REPO = path.join(__dirname, '..', '..');

// showIds: the set of show directories touched by the diff (derived from the
// changed-file list, not from card text) — verify-review-recovery.js and
// validate-show-venue.js both operate per-show.
function verifierArgvFor(cls, { dataDir, showIds }) {
  const node = process.execPath || 'node';
  switch (cls) {
    case 'missing-show':
      // Target only the show(s) this diff actually added (showIds, derived
      // from a shows.json before/after id diff — see
      // showIdsFromShowsJsonDiff in autonomous-data-workdir.js), via
      // --show=<id>: same Playbill cross-check as --all-provisional but for
      // exactly the entry this card touched. --show= bypasses the
      // isProvisional() filter entirely so it validates regardless of the
      // card's discoverySource/provisional flag.
      //
      // Previously ran --all-provisional here on every single attempt,
      // re-validating every one of the ~40 provisional shows in shows.json
      // against Playbill each time — the comment claimed this was "cheap
      // (cache-hit heavy)", but validate-show-venue.js never writes to its
      // own read cache (only discover-playbill-urls.js and
      // fetch-show-images-auto.js do), so every attempt paid full SERP+fetch
      // cost for the entire provisional backlog. That made it one of the
      // top Bright Data callers on every day in the ledger (BRO-2226:
      // 188-825 req/day) for zero correctness benefit over targeting just
      // the added show — a wrong-show/wrong-venue implementer bug is
      // exactly as catchable via --show=<addedId>.
      //
      // Fallback: if the diff added zero or an unresolvable set of ids
      // (parse failure, non-standard diff shape), fall back to the full
      // --all-provisional scan rather than skipping validation — a false
      // "no verifier ran" here is worse than the wasted BD spend.
      if (Array.isArray(showIds) && showIds.length) {
        return showIds.map((id) => ({
          name: `validate-show-venue --show=${id}`,
          argv: [node, path.join(REPO, 'scripts', 'validate-show-venue.js'), `--show=${id}`, '--fail-on-mismatch', `--data-dir=${dataDir}`],
        }));
      }
      return [{
        name: 'validate-show-venue (--all-provisional fallback: no showIds resolved)',
        argv: [node, path.join(REPO, 'scripts', 'validate-show-venue.js'), '--all-provisional', '--fail-on-mismatch', `--data-dir=${dataDir}`],
      }];
    case 're-gather':
    case 'byline-recovery':
    case 'cluster-cleanup':
      // One verify-review-recovery.js call per touched show, --pre-merge:
      // reviews.json/public per-show JSON reflect main, not this unmerged
      // branch, so the rebuild-inclusion/production checks would fail every
      // correct diff. Full re-verify (no --pre-merge) re-runs at merge time
      // in CI once the change is actually live (mirrors Sprint 3's rebased
      // re-verify, not a duplicate of it).
      return (showIds || []).map(id => ({
        name: `verify-review-recovery --show=${id} --pre-merge`,
        argv: [node, path.join(REPO, 'scripts', 'verify-review-recovery.js'), `--show=${id}`, '--pre-merge'],
      }));
    default:
      return [];
  }
}

module.exports = { verifierArgvFor };
