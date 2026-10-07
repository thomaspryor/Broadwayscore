/**
 * Preflight check before gather-reviews.js triggers a full local
 * rebuild-all-reviews.js pass (BRO-2276). A cloud-bootstrapped worktree, or
 * any checkout where data/review-texts wasn't fully cloned, can have the
 * directory missing entirely or scoped to a single show — running a full
 * rebuild against it folds a near-empty dataset into reviews.json. Catching
 * that here, before the subprocess is even spawned, is the first line of
 * defense; scripts/lib/regression-guard.js's hard block inside
 * rebuild-all-reviews.js itself is the second (for anyone invoking that
 * script directly).
 *
 * data/review-texts is never a git checkout with its own .git on this
 * machine even in the fully-set-up case — setup-local-data.sh clones
 * broadway-review-texts to a temp dir and `rm -rf`s its .git before copying
 * the contents into data/review-texts (see setup-local-data.sh's Review
 * Texts step). So ".git present" is NOT a valid signal here; a show-directory
 * count floor is.
 */

const fs = require('fs');
const { listShowDirs } = require('./list-show-dirs');

const MIN_SHOW_DIRS = 500;

/**
 * @param {string} reviewTextsDir - absolute path to data/review-texts
 * @param {object} [opts]
 * @param {number} [opts.minShowDirs]
 * @returns {{ok: boolean, reason?: string, showDirCount: number}}
 */
function checkReviewTextsPreflight(reviewTextsDir, opts = {}) {
  const minShowDirs = opts.minShowDirs ?? MIN_SHOW_DIRS;

  if (!fs.existsSync(reviewTextsDir)) {
    return { ok: false, reason: `data/review-texts does not exist at ${reviewTextsDir}`, showDirCount: 0 };
  }

  let showDirCount;
  try {
    showDirCount = listShowDirs(reviewTextsDir, { silent: true }).length;
  } catch (e) {
    return { ok: false, reason: `could not list data/review-texts: ${e.message}`, showDirCount: 0 };
  }

  if (showDirCount < minShowDirs) {
    return {
      ok: false,
      reason: `data/review-texts has only ${showDirCount} show director${showDirCount === 1 ? 'y' : 'ies'} (need >= ${minShowDirs}) — looks like a stub/partial checkout`,
      showDirCount,
    };
  }

  return { ok: true, showDirCount };
}

module.exports = { checkReviewTextsPreflight, MIN_SHOW_DIRS };
