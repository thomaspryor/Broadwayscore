/**
 * stale-merge-check.js — BRO-3790
 *
 * createOrMergeReviewFile's merge-into-existing path (review-file-writer.js
 * _mergeIntoExisting) only fills fields that are currently blank on the
 * existing file — url is further gated by maybeUpgradeUrl's own "existing
 * content is bad" check, and criticName is never merged at all (it's only
 * used as an identity key, not a mergeable field). A caller that re-ingests
 * against a show+outlet whose file already has a non-blank (but wrong)
 * url/criticName/fullText therefore gets back `action: 'updated'` — the
 * writer DID write something (e.g. a metadata field) — while the exact
 * value the caller was trying to correct silently stays the old one. The
 * caller has no way to tell "my correction landed" from "something
 * unrelated changed" without checking.
 *
 * findStaleMergeFields is that check: it diffs the caller's INTENDED values
 * against what actually landed on disk, so a caller like
 * ingest-review-from-url.js can refuse to report success when a field it
 * explicitly asked to set didn't take.
 */

'use strict';

/**
 * @param {object} intended - fields this write attempted to establish, keyed
 *   by field name. Omit a key entirely (don't pass it as null/undefined) when
 *   the caller has no opinion on it — e.g. criticName was auto-extracted
 *   rather than explicitly supplied, so a mismatch there isn't a correction
 *   that failed to land, just a value nobody asked to change.
 * @param {object} landed - the record actually read back from disk after the
 *   write, e.g. `JSON.parse(fs.readFileSync(result.filepath, 'utf8'))`.
 * @returns {string[]} field names where the intended value did not land.
 */
function findStaleMergeFields(intended, landed) {
  const stale = [];
  for (const key of Object.keys(intended)) {
    if (intended[key] == null) continue;
    if (!landed || landed[key] !== intended[key]) stale.push(key);
  }
  return stale;
}

module.exports = { findStaleMergeFields };
