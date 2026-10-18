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
 * flagged wrong production/show, not a non-review, not a duplicate or round-up.
 * The audit (audit-sibling-title-misroute.js) and the write guards share it.
 */
function isCountedSameUrlCopy(d) {
  if (!d) return false;
  if (d.wrongProduction === true || d.wrongShow === true) return false;
  if (d.isNonReview === true || d.nonReviewFlag === true || d.nonReviewContent === true) return false;
  return !d.duplicateOf && d.isRoundupArticle !== true;
}

/**
 * Does this write carry a date the market router can route on? A parseable
 * publishDate, or a /YYYY/MM/ url path. classifyMarketRouting scores no signal
 * without one, which is the gap this guard closes.
 */
function hasRoutingDate({ url, publishDate } = {}) {
  if (publishDate && require('./date-utils').parseDate(String(publishDate))) return true;
  return require('./review-guards').urlYearFromPath(url) != null;
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
 * @param {Set<string>|Array<string>} [args.skipShowIds]  e.g. the reroute chain this write came through
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
    let names;
    try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'failed-fetches.json').sort(); } catch { continue; }
    for (const file of names) {
      let data;
      try { data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { continue; }
      if (!data || !data.url || sameUrlKey(data.url) !== key || !isCounted(data)) continue;
      return { showId: sib.id, file, url: data.url };
    }
  }
  return null;
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

module.exports = { findSiblingSameUrlPairs, findSameTitleSiblingUrlHolder, isCountedSameUrlCopy, hasRoutingDate };
