/**
 * Merged-away URL tombstones (BRO-4414).
 *
 * Merging two review files for one article deletes the loser, and with it the
 * only record that the loser's URL exists. The next aggregator/poller pass sees
 * that URL as new: mergeReviews swaps it onto the survivor and
 * applyUrlChangeInvariant wipes the survivor's text + score (Culture Sauce
 * "How Shakespeare Saved My Life", 2026-09-30), or the writers re-create the
 * deleted duplicate file.
 *
 * The survivor therefore carries `mergedDuplicateUrls`: every URL folded into it.
 * Writers refuse to adopt, or re-create a file for, any URL on that list.
 * The field is deliberately not URL-derived state, so applyUrlChangeInvariant
 * never clears it.
 */
const fs = require('fs');
const path = require('path');
const { normalizeUrl } = require('./review-normalization');

const MAX_TRACKED = 50;

function keyOf(url) {
  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
  return normalizeUrl(url);
}

/** True when `url` was folded into `record` by an earlier merge. */
function isMergedDuplicateUrl(record, url) {
  const k = keyOf(url);
  if (!k || !record || !Array.isArray(record.mergedDuplicateUrls)) return false;
  return record.mergedDuplicateUrls.some((u) => keyOf(u) === k);
}

/**
 * Record `url` on `target` as merged away. No-op for the target's own URL, an
 * empty/garbage URL, or one already recorded. Returns true when target changed.
 */
function recordMergedDuplicateUrl(target, url) {
  const k = keyOf(url);
  if (!k || !target) return false;
  if (target.url && keyOf(target.url) === k) return false;
  const list = Array.isArray(target.mergedDuplicateUrls) ? target.mergedDuplicateUrls : [];
  if (list.some((u) => keyOf(u) === k)) return false;
  target.mergedDuplicateUrls = [...list, url].slice(-MAX_TRACKED);
  return true;
}

/**
 * Fold everything `source` knows into `target`: its own URL plus the tombstones
 * it already carried (a survivor that is itself merged away later, A<-B<-C).
 * Returns true when target changed.
 */
function absorbMergedDuplicates(target, source) {
  if (!target || !source) return false;
  let changed = recordMergedDuplicateUrl(target, source.url);
  if (Array.isArray(source.mergedDuplicateUrls)) {
    for (const u of source.mergedDuplicateUrls) if (recordMergedDuplicateUrl(target, u)) changed = true;
  }
  return changed;
}

/**
 * Find a file in `showDir` (same outlet) that a merge already folded `url` into.
 * Reads only the show's own directory; fails open (null) on any read error.
 */
function findMergedDuplicateOwner({ showDir, url, outletId, normalizeOutletId = (x) => x }) {
  const k = keyOf(url);
  if (!k || !showDir) return null;
  let files;
  try { files = fs.readdirSync(showDir); } catch { return null; }
  const want = outletId ? normalizeOutletId(outletId) : null;
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(showDir, f), 'utf8')); } catch { continue; }
    if (!d || !Array.isArray(d.mergedDuplicateUrls) || !isMergedDuplicateUrl(d, url)) continue;
    if (want && d.outletId && normalizeOutletId(d.outletId) !== want) continue;
    return { filename: f, data: d };
  }
  return null;
}

module.exports = { isMergedDuplicateUrl, recordMergedDuplicateUrl, absorbMergedDuplicates, findMergedDuplicateOwner, MAX_TRACKED };
