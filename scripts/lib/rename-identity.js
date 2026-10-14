'use strict';
/**
 * rename-identity (BRO-5356): which committed version a staged review file is
 * compared against when protected fields are restored at push time.
 *
 * The restores (push-review-texts' pre-commit "Protected" block and its
 * newer-scoring carry, and restore-protected-fields.js after a rebase) look up
 * the committed file at the SAME PATH. When a plan deletes X and renames Y onto
 * X's path, that is X's history, not Y's: plan bro-5243-h put a deleted
 * duplicate's llmScore (93 over 94) and its duplicateOf (pointing at the file
 * just renamed) onto all-my-sons-2019 and grand-horizons-2020.
 *
 * safeRenameReview and the review-file restore stamp `_renamedFrom: { file, at }`
 * ('<show>/<file>' relative to the review-texts root). A file whose stamp is
 * not already on the committed version at its path was renamed in this push,
 * so its history is the source path's.
 */

/** Was `local` renamed onto its path since `atPath` (the committed version there) was written? */
function renamedSinceCommit(local, atPath) {
  const r = local && local._renamedFrom;
  if (!r || typeof r.file !== 'string' || !r.file) return false;
  const prior = atPath && atPath._renamedFrom;
  return !(prior && prior.at === r.at && prior.file === r.file);
}

/**
 * The committed version that is this file's own history, or null when there is
 * none (a new file, or a renamed file whose source was never committed).
 * @param {string} filePath - path of the staged file (as git sees it)
 * @param {object} local - the staged record
 * @param {(p: string) => object} readCommitted - parses `<ref>:<p>`; throws when absent
 */
function committedHistoryFor(filePath, local, readCommitted) {
  let atPath = null;
  try { atPath = readCommitted(filePath); } catch { atPath = null; }
  if (!renamedSinceCommit(local, atPath)) return atPath;
  try { return readCommitted(local._renamedFrom.file); } catch { return null; }
}

/** The stamp a rename writes onto the moved record. */
function renameStamp(srcShowId, srcFile, at = new Date().toISOString()) {
  return { file: `${srcShowId}/${srcFile}`, at };
}

module.exports = { renamedSinceCommit, committedHistoryFor, renameStamp };
