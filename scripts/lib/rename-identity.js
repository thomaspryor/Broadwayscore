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
 *
 * A plan that deletes X and then writes a new X (a re-split, a re-ingest, a
 * restore from an older commit) leaves a file with no history of its own: the
 * deleted copy is what the plan meant to throw away. execute-approved-fix stamps
 * such files `_recreatedAfterDelete: { fixId, at }`, and the restore reads no
 * committed version for them (BRO-5942: a mis-cut child's wrongProduction came
 * back onto the clean re-split row and the rebuild marked it invalid).
 */

/** Was `local` renamed onto its path since `atPath` (the committed version there) was written? */
function renamedSinceCommit(local, atPath) {
  const r = local && local._renamedFrom;
  if (!r || typeof r.file !== 'string' || !r.file) return false;
  const prior = atPath && atPath._renamedFrom;
  return !(prior && prior.at === r.at && prior.file === r.file);
}

/** Was `local` deleted and written anew by a plan since `atPath` was committed? */
function recreatedSinceCommit(local, atPath) {
  const r = local && local._recreatedAfterDelete;
  if (!r || typeof r.at !== 'string' || !r.at) return false;
  const prior = atPath && atPath._recreatedAfterDelete;
  return !(prior && prior.at === r.at && prior.fixId === r.fixId);
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
  // A fresh rename names the right history (delete X, move Y onto X: Y's);
  // the recreate stamp only matters when nothing was renamed in.
  if (renamedSinceCommit(local, atPath)) {
    try { return readCommitted(local._renamedFrom.file); } catch { return null; }
  }
  if (recreatedSinceCommit(local, atPath)) return null;
  return atPath;
}

/** The stamp a rename writes onto the moved record. */
function renameStamp(srcShowId, srcFile, at = new Date().toISOString()) {
  return { file: `${srcShowId}/${srcFile}`, at };
}

/** The stamp execute-approved-fix writes onto a file its plan deleted and wrote anew. */
function recreateStamp(fixId, at = new Date().toISOString()) {
  return { fixId: String(fixId), at };
}

/**
 * Stamp every path in `deleted` (relative to the review-texts root) that exists
 * again after the plan, so the push-time restore leaves it as the plan wrote it.
 * @returns {string[]} the stamped paths
 */
function stampRecreatedReviews(reviewTextsDir, deleted, fixId, { write, at = new Date().toISOString() } = {}) {
  const fs = require('fs');
  const path = require('path');
  const save = write || ((abs, rec) => require('./review-write-guard').safeWriteReview(abs, rec));
  const stamped = [];
  for (const rel of deleted) {
    const abs = path.join(reviewTextsDir, rel);
    if (!fs.existsSync(abs)) continue;
    let rec;
    try { rec = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { continue; }
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
    try {
      const res = save(abs, { ...rec, _recreatedAfterDelete: recreateStamp(fixId, at) });
      if (res && res.wrote === false) continue;
    } catch (e) {
      console.warn(`  could not stamp ${rel} as recreated: ${e.message}`);
      continue;
    }
    stamped.push(rel);
  }
  return stamped;
}

module.exports = { renamedSinceCommit, recreatedSinceCommit, committedHistoryFor, renameStamp, recreateStamp, stampRecreatedReviews };
