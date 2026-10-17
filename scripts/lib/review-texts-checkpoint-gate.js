'use strict';

// BRO-2381: pushReviewTextsCheckpoint() in scripts/collect-review-texts.js
// gates on REVIEW_TEXTS_TOKEN + GITHUB_ACTIONS with a bare `return` and no
// logging — confirmed by scripts/audit-workflow-secret-gaps.js (task #1855)
// as a real gap: several workflows (bulk-collect-review-texts.yml,
// collect-free-reviews.yml, collect-hard-paywall.yml, collect-soft-
// paywall.yml, opening-night-express.yml, overnight-collect.yml,
// rescrape-truncated.yml) invoke collect-review-texts.js in a step whose env
// never provides REVIEW_TEXTS_TOKEN, so the mid-run checkpoint push silently
// no-ops for the entire run — the only crash-safety net for scraped review
// text between the final commitChanges() call and job timeout/cancellation.
//
// Pure decision function, extracted so both the caller and its test can
// require() the same logic (CLAUDE.md rule 15) instead of the test
// reimplementing the condition inline.
function shouldPushReviewTextsCheckpoint(env = process.env) {
  const hasToken = Boolean(env.REVIEW_TEXTS_TOKEN);
  const hasCi = Boolean(env.GITHUB_ACTIONS);
  if (hasToken && hasCi) return { ok: true, reason: null };
  if (!hasToken && !hasCi) return { ok: false, reason: 'REVIEW_TEXTS_TOKEN not set and not running in GitHub Actions' };
  if (!hasToken) return { ok: false, reason: 'REVIEW_TEXTS_TOKEN not set' };
  return { ok: false, reason: 'not running in GitHub Actions (GITHUB_ACTIONS unset)' };
}

// BRO-3599: a checkpoint whose push failed leaves its commit local-only. The
// next checkpoint used `git diff --staged --quiet` as its "is there work to
// push" test, so when no NEW file changed it saw a clean index and returned,
// and the "will retry at next checkpoint" promise never ran. Unpushed commits
// are counted separately from the staged diff.
//
// Returns the number of commits on HEAD that origin/<branch> lacks, or null
// when that can't be determined (no remote-tracking ref, not a repo). Never
// throws.
function countUnpushedCommits(cwd, branch = 'main') {
  const { execFileSync } = require('child_process');
  try {
    const out = execFileSync('git', ['rev-list', '--count', `origin/${branch}..HEAD`], {
      cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000,
    }).toString().trim();
    const n = Number.parseInt(out, 10);
    return Number.isFinite(n) ? n : null;
  } catch (_) {
    return null;
  }
}

// What a checkpoint does given its staged-diff state and the unpushed count:
//   'commit-and-push' new changes are staged
//   'push-only'       nothing new, but an earlier checkpoint commit is unpushed
//   'skip'            nothing to commit and nothing to push (or unknown count)
function decideCheckpointAction({ hasStagedChanges, unpushedCommits }) {
  if (hasStagedChanges) return 'commit-and-push';
  if (Number.isFinite(unpushedCommits) && unpushedCommits > 0) return 'push-only';
  return 'skip';
}

module.exports = { shouldPushReviewTextsCheckpoint, countUnpushedCommits, decideCheckpointAction };
