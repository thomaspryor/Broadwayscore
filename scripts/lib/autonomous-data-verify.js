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
      // --all-provisional re-validates every provisional/manual-discovery
      // entry against Playbill, not just the one this card claims to have
      // added — cheap (cache-hit heavy) and catches an implementer that
      // added the WRONG show id/venue under a right-looking title.
      return [{
        name: 'validate-show-venue (--all-provisional)',
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
