'use strict';
/**
 * One review url counted under two productions of the same title (BRO-4674).
 *
 * classifyMarketRouting judges each file alone from its url and publishDate, so
 * a file with neither a dated url nor a publishDate scores no signal and is
 * accepted wherever it lands. When the same url is ALSO held by a file in a
 * same-title sibling's folder, the one article is counted on both productions.
 * Found 2026-10-13: the-comedy-about-spies-west-end-2026/sunday-times--unknown
 * (serp-discovery, undated) is the 2025 Times review that
 * the-comedy-about-spies-west-end-2025/times-uk--clive-davis already holds;
 * leopoldstadt-west-end-2021 carried three 2020 reviews scraped off a Show
 * Score page that lists both runs.
 *
 * findSiblingSameUrlPairs is report-only: which copy is wrong needs a person
 * (or a date) to decide. findSameTitleSiblingUrlHolder is the write-time half
 * (BRO-5298): review-file-writer and gather-reviews refuse an UNDATED new write
 * whose url a same-title sibling already holds, so the second copy is never made.
 */
const fs = require('fs');
const path = require('path');
const { sameUrlKey } = require('./review-url-collision');

/**
 * True when a file would count toward a score for same-url purposes: not
 * flagged wrong production/show, not a non-review, not a duplicate pointer
 * (duplicateOf/duplicateTextOf defer to the file they name, BRO-5373) and not
 * a round-up or combined multi-show article. Matches url-ownership.js
 * _isBlockingOwnerCopy (Guard I) plus the non-review flags. The audit
 * (audit-sibling-title-misroute.js) and the write guards share it.
 */
function isCountedSameUrlCopy(d) {
  if (!d || typeof d !== 'object') return false;
  if (d.wrongProduction === true || d.wrongShow === true) return false;
  if (d.isNonReview === true || d.nonReviewFlag === true || d.nonReviewContent === true) return false;
  if (d.isRoundupArticle === true || d.isCombinedReview === true) return false;
  return !d.duplicateOf && !d.duplicateTextOf;
}

/**
 * A 4-digit year token in the url (`-2021-`, `/2020/`, `.2019.`). The same
 * token gather-reviews' cross-show URL-index check re-homes on.
 * @returns {number|null}
 */
function urlSlugYear(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(/(?:[\/\-_.])((?:19|20)\d\d)(?:[\/\-_.]|$)/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Does this write carry a date something downstream can route on? A
 * parseable publishDate, or a year token in the url (/YYYY/MM/ paths
 * included). Without one classifyMarketRouting scores no signal, which is
 * the gap the same-title sibling guard closes.
 */
function hasRoutingDate({ url, publishDate } = {}) {
  if (publishDate && require('./date-utils').parseDate(String(publishDate))) return true;
  return urlSlugYear(url) != null;
}

// Per-process cache of a sibling folder's counted urls (sameUrlKey -> files),
// rebuilt when the folder's mtime moves (a file added, removed or renamed).
// An in-place edit does not move the mtime, so every hit is re-read before it
// is trusted; a url swapped in place is missed (fail open, never a false refusal).
const _folderCache = new Map();
function _folderUrlKeys(dir) {
  let mtimeMs;
  try { mtimeMs = fs.statSync(dir).mtimeMs; } catch { return null; }
  const hit = _folderCache.get(dir);
  if (hit && hit.mtimeMs === mtimeMs) return hit.keys;
  const keys = new Map();
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'failed-fetches.json').sort(); } catch { return null; }
  for (const file of names) {
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { continue; }
    const k = data && sameUrlKey(data.url);
    if (!k) continue;
    if (!keys.has(k)) keys.set(k, []);
    keys.get(k).push(file);
  }
  _folderCache.set(dir, { mtimeMs, keys });
  return keys;
}

/**
 * Which same-title sibling folder already holds a counted copy of `url`?
 * Fails open (unreadable folder or file = no holder).
 *
 * @param {object} args
 * @param {string} args.showId
 * @param {string} args.url
 * @param {Map} args.siblingIndex  buildSiblingIndex() output
 * @param {string} args.reviewTextsDir
 * @param {Iterable<string>} [args.skipShowIds]  the reroute chain this write came through
 * @param {(data: object) => boolean} [args.isCounted]
 * @returns {{showId: string, file: string, url: string}|null}
 */
function findSameTitleSiblingUrlHolder({ showId, url, siblingIndex, reviewTextsDir, skipShowIds, isCounted = isCountedSameUrlCopy } = {}) {
  const key = sameUrlKey(url);
  if (!key || !showId || !reviewTextsDir || !siblingIndex || typeof siblingIndex.get !== 'function') return null;
  const entry = siblingIndex.get(showId);
  const skip = new Set(skipShowIds || []);
  for (const sib of (entry && entry.siblings) || []) {
    if (!sib || !sib.id || sib.id === showId || skip.has(sib.id)) continue;
    const dir = path.join(reviewTextsDir, sib.id);
    const keys = _folderUrlKeys(dir);
    for (const file of (keys && keys.get(key)) || []) {
      let data;
      try { data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { continue; }
      if (!data || sameUrlKey(data.url) !== key || !isCounted(data)) continue;
      return { showId: sib.id, file, url: data.url };
    }
  }
  return null;
}

/**
 * The write-time verdict both writers use (review-file-writer Guard A2 and
 * gather-reviews createReviewFile), so the two paths cannot disagree.
 * Refuses an UNDATED write whose url a same-title sibling holds a counted copy
 * of, unless this show's own folder already holds the url (a merge into an
 * existing pair is the audit's to settle). Aggregator/round-up page urls are
 * left to their own guards. Caller-specific opt-outs go in `bypass`.
 *
 * @returns {{reason: string, holder: {showId: string, file: string, url: string}}|null}
 */
function sameTitleSiblingUrlRefusal({ showId, url, publishDate, siblingIndex, reviewTextsDir, skipShowIds, bypass = false } = {}) {
  if (bypass || !url || !showId || !reviewTextsDir) return null;
  if (hasRoutingDate({ url, publishDate })) return null;
  if (require('./review-slot-guards').isAggregatorPageUrl(url)) return null;
  const holder = findSameTitleSiblingUrlHolder({ showId, url, siblingIndex, reviewTextsDir, skipShowIds });
  if (!holder) return null;
  const { findSiblingUrlOwner } = require('./review-url-collision');
  if (findSiblingUrlOwner({ showDir: path.join(reviewTextsDir, showId), url })) return null;
  return { reason: `same-title-sibling-url:${holder.showId}`, holder };
}

/**
 * @param {Map<string, {siblings: Array<{id: string}>}>} siblingIndex  buildSiblingIndex() output
 * @param {(showId: string) => Array<{file: string, data: object}>} loadFiles  a folder's review files
 * @param {(data: object) => boolean} isCounted  true when the file would count toward a score
 * @param {(left: object, right: object) => boolean} [skipPair]  true when a person already
 *   decided both copies stand (e.g. both carry a wrongProduction clear)
 * @returns {Array<{showId: string, file: string, targetShowId: string, targetFile: string, url: string}>}
 *   one entry per pair, reported on the lexically first show id
 */
function findSiblingSameUrlPairs(siblingIndex, loadFiles, isCounted, skipPair = () => false) {
  const byShow = new Map();
  const keyed = (showId) => {
    if (!byShow.has(showId)) {
      const m = new Map();
      for (const { file, data } of loadFiles(showId) || []) {
        if (!data || !data.url || !isCounted(data)) continue;
        const k = sameUrlKey(data.url);
        if (k && !m.has(k)) m.set(k, { file, url: data.url, data });
      }
      byShow.set(showId, m);
    }
    return byShow.get(showId);
  };

  const pairs = [];
  const seen = new Set();
  for (const [showId, entry] of siblingIndex) {
    for (const sib of (entry && entry.siblings) || []) {
      const [a, b] = [showId, sib.id].sort();
      const pairKey = `${a}|${b}`;
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);
      const left = keyed(a);
      if (left.size === 0) continue;
      const right = keyed(b);
      for (const [k, l] of left) {
        const r = right.get(k);
        if (r && !skipPair(l.data, r.data)) pairs.push({ showId: a, file: l.file, targetShowId: b, targetFile: r.file, url: l.url });
      }
    }
  }
  return pairs;
}

module.exports = {
  findSiblingSameUrlPairs, findSameTitleSiblingUrlHolder, sameTitleSiblingUrlRefusal,
  isCountedSameUrlCopy, hasRoutingDate, urlSlugYear,
  _resetSiblingFolderCache: () => _folderCache.clear(),
};
