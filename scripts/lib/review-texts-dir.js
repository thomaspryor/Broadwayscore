'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Which review-texts clone should a tool operate on?
 *
 * Two checkouts exist and they are NOT the same tree:
 *   - <main-checkout>/data/review-texts — what the pipeline actually reads
 *     (validate-review-texts.js, review-guards.js, autonomous-data-workdir.js:39,
 *     and CI via .github/actions/checkout-review-texts)
 *   - ~/broadway-review-texts — a legacy clone several older scripts default to
 *
 * On 2026-08-17 those two were 143+ commits apart, and a WRITING repair tool
 * defaulted to the legacy one: it reported a cycle for a show already fixed in
 * the real clone.
 *
 * THE FIRST VERSION OF THIS HELPER WAS WORSE THAN THE BUG IT FIXED, and a code
 * review caught it by executing the resolver against this machine's 32 real
 * worktrees. Two ways:
 *
 *   1. `existsSync(nested)` is true for a BARE directory. Three worktrees here
 *      carry an empty or plain-copy data/review-texts. Pointed at an empty one,
 *      the caller's readdirSync returns [] and the tool prints "0 cycles found"
 *      and exits 0 — a false all-clear, strictly worse than the legacy default,
 *      which at least pointed at a real corpus. Pointed at the stale plain copy
 *      (1994 show dirs vs the real 2016), `--apply` writes repairs into a
 *      throwaway directory that is never committed, and reports success.
 *      So: require a real CHECKOUT (a .git entry), not merely a directory.
 *
 *   2. data/review-texts is gitignored, so it exists only where someone cloned
 *      it — almost always the MAIN checkout, not a worktree. But repoRoot
 *      defaults to this file's own repo root, which inside a worktree IS the
 *      worktree. CLAUDE.md mandates worktree-first for every scripts/ edit, so
 *      the most likely place this tool runs was precisely where the fix did not
 *      apply and it silently fell back to the stale legacy clone.
 *      So: when the local root has no clone, ask git for the MAIN worktree and
 *      look there before falling back.
 *
 * Order: explicit REVIEW_TEXTS_DIR (an operator naming the directory is never
 * overridden, even if it is empty — that is their call) -> a real clone at
 * <repoRoot>/data/review-texts -> a real clone at the main worktree -> the
 * legacy home clone.
 *
 * Callers should PRINT the resolved path AND fail loudly on a missing target;
 * an ambiguous or silently-empty target is the whole bug class.
 */

/** A directory only counts if it is an actual checkout, not a bare/empty dir. */
function isReviewTextsCheckout(dir) {
  try {
    return fs.existsSync(path.join(dir, '.git')) && fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * The repository's MAIN working tree, or null. Inside a git worktree this is the
 * checkout that actually holds the gitignored data/ clones.
 */
function mainWorktreeOf(repoRoot) {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!common) return null;
    // <main>/.git -> <main>
    return path.basename(common) === '.git' ? path.dirname(common) : null;
  } catch {
    return null;
  }
}

/**
 * @param {object} [env] defaults to process.env
 * @param {string} [repoRoot] defaults to the repo containing this file
 * @param {string} [homedir] defaults to os.homedir()
 * @param {object} [deps] injection seam for tests: {isCheckout, mainWorktree}
 * @returns {string}
 */
function resolveReviewTextsDir(
  env = process.env,
  repoRoot = path.join(__dirname, '..', '..'),
  homedir = os.homedir(),
  deps = {},
) {
  const isCheckout = deps.isCheckout || isReviewTextsCheckout;
  const mainWorktree = deps.mainWorktree || mainWorktreeOf;

  if (env.REVIEW_TEXTS_DIR) return env.REVIEW_TEXTS_DIR;

  const nested = path.join(repoRoot, 'data', 'review-texts');
  if (isCheckout(nested)) return nested;

  // Inside a worktree the clone lives in the main checkout, not here.
  const main = mainWorktree(repoRoot);
  if (main && path.resolve(main) !== path.resolve(repoRoot)) {
    const fromMain = path.join(main, 'data', 'review-texts');
    if (isCheckout(fromMain)) return fromMain;
  }

  return path.join(homedir, 'broadway-review-texts');
}

module.exports = { resolveReviewTextsDir, isReviewTextsCheckout, mainWorktreeOf };
