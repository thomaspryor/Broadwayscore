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

module.exports = { shouldPushReviewTextsCheckpoint };
