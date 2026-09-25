'use strict';

/**
 * sparse-checkout-guard.js — is a show directory missing on disk only because
 * this review-texts checkout is sparse?
 *
 * 2026-09-25: a gap-audit run from a sparse side-clone of broadway-review-texts
 * rerouted a 2017 WSJ URL from the-children-off-west-end-2026 to
 * the-children-2017, a show that was NOT in the clone's sparse set. The writer
 * saw no existing file, CREATED a fresh wsj--edward-rothstein.json, and a
 * `git add` of that path would have replaced the scored review on origin
 * (assignedScore 76, excerpts, contentTier complete -> truncated). With a full
 * checkout the same write merges into the existing file and changes nothing.
 *
 * Only consulted when the target show directory does not exist, so a normal
 * full checkout pays nothing. Fails open (returns false) outside a git repo or
 * when git itself errors: a missing directory in a non-sparse corpus is a
 * genuinely new show.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function _git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], {
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
    timeout: 10000,
  }).trim();
}

/**
 * @param {string} reviewTextsDir root of the review-texts checkout
 * @param {string} showId
 * @returns {boolean} true when the checkout is sparse AND files under showId/
 *   carry the skip-worktree bit (outside the sparse set)
 */
function isShowDirHiddenBySparseCheckout(reviewTextsDir, showId) {
  if (!reviewTextsDir || !showId) return false;
  if (fs.existsSync(path.join(reviewTextsDir, showId))) return false;
  try {
    if (_git(reviewTextsDir, ['config', '--bool', 'core.sparseCheckout']) !== 'true') return false;
  } catch { return false; }
  return _anySkipWorktree(reviewTextsDir, `./${showId}/`);
}

// The skip-worktree bit (`S` in `git ls-files -v`) is what sparse checkout
// sets on paths outside the sparse set. Keying on it, not on "tracked at HEAD
// but absent", keeps a file deleted by hand INSIDE the sparse set writable
// (review 2026-09-25: the HEAD test refused delete-then-recreate).
// Pathspecs are relative to -C, so a subdirectory review-texts root works.
function _anySkipWorktree(dir, pathspec) {
  let out;
  try { out = _git(dir, ['ls-files', '-v', '--', pathspec]); } catch { return false; }
  return out.split('\n').some(line => line.startsWith('S '));
}

/**
 * File-level form for the low-level write choke point (safeWriteReview):
 * true when filePath is absent on disk and git marks it skip-worktree in a sparse
 * checkout, so "create" would really be "replace the committed version".
 * Callers mkdir the show directory before writing, so the directory test
 * above can't catch that path; this one checks the file itself.
 * @param {string} filePath
 * @returns {boolean}
 */
function isPathHiddenBySparseCheckout(filePath) {
  if (!filePath || fs.existsSync(filePath)) return false;
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) return false;
  try {
    if (_git(dir, ['config', '--bool', 'core.sparseCheckout']) !== 'true') return false;
  } catch { return false; }
  return _anySkipWorktree(dir, `./${path.basename(filePath)}`);
}

module.exports = { isShowDirHiddenBySparseCheckout, isPathHiddenBySparseCheckout };
