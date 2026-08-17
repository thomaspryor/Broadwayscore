'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Which review-texts clone should a tool operate on?
 *
 * Two checkouts exist on a dev machine and they are NOT the same tree:
 *   - <repo>/data/review-texts — what the pipeline actually reads
 *     (validate-review-texts.js, review-guards.js, autonomous-data-workdir.js:39)
 *   - ~/broadway-review-texts — a legacy clone several older scripts still
 *     default to (audit-review-url-clusters.js, classify-unscored-blocked-url.js,
 *     verify-misroute-content.js, and others)
 *
 * On 2026-08-17 those two were 143+ commits apart, and a WRITING repair tool
 * defaulted to the legacy one: it reported "1 cycle found" for a show whose
 * cycle had already been fixed in the real clone. A tool that can silently
 * repair the wrong copy and report success is worse than one that refuses.
 *
 * Order: explicit env var (an operator naming the directory is never overridden)
 * -> the repo's own nested checkout when it exists -> the legacy home clone
 * (a git worktree has no nested clone, so that fallback must keep working).
 *
 * Callers should PRINT the resolved path — an ambiguous target is the bug.
 *
 * @param {object} [env] defaults to process.env
 * @param {string} [repoRoot] defaults to the repo containing this file
 * @param {string} [homedir] defaults to os.homedir()
 * @returns {string}
 */
function resolveReviewTextsDir(env = process.env, repoRoot = path.join(__dirname, '..', '..'), homedir = os.homedir()) {
  if (env.REVIEW_TEXTS_DIR) return env.REVIEW_TEXTS_DIR;
  const nested = path.join(repoRoot, 'data', 'review-texts');
  if (fs.existsSync(nested)) return nested;
  return path.join(homedir, 'broadway-review-texts');
}

module.exports = { resolveReviewTextsDir };
