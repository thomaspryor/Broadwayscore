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
 * Report-only: which copy is wrong needs a person (or a date) to decide.
 */
const { sameUrlKey } = require('./review-url-collision');

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

module.exports = { findSiblingSameUrlPairs };
