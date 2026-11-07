'use strict';
const path = require('path');

/**
 * BRO-3112: honour an explicit REVIEW_TEXTS_DIR (test sandboxes) and otherwise
 * keep the script's own default. Deliberately NOT resolveReviewTextsDir(): that
 * helper's main-worktree fallback would change where a pipeline script writes.
 */
function reviewTextsDirFromEnv(defaultDir, env = process.env) {
  const v = env.REVIEW_TEXTS_DIR;
  return v && v.trim() ? path.resolve(v.trim()) : defaultDir;
}

module.exports = { reviewTextsDirFromEnv };
