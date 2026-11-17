'use strict';
/**
 * BRO-7646: the rebuild must never drop an opening-night lane row whose review text has not reached
 * review-texts yet. The lane writes reviews.json rows directly and pushes the text files only when it ends,
 * hours later. The lease carry-over in rebuild-all-reviews.js protects those rows only when the job synced
 * the lease file first, and most rebuild-running workflows never do: fetch-guardian-reviews rebuilt at
 * 05:04Z on the Fantasticks press night (2026-11-17) and wiped all 20 lane rows.
 *
 * Pure. Returns the existing lane rows to add back: rows the lane wrote (isLaneReview, matched to the show's
 * opening night), for a show not already carried by a lease, with no rebuilt row at the same URL, and whose URL
 * has no review-text file yet. A row whose text file exists is left to the rebuild, so its exclusions still apply.
 *
 * @param {object[]} existingRows rows of the reviews.json being replaced
 * @param {object[]} rebuiltRows rows the rebuild produced
 * @param {{shows: object[], leasedShowIds?: Set<string>, textUrls: (showId: string) => Iterable<string>,
 *   canonicalUrl: (url: string) => string}} ctx
 * @returns {object[]}
 */
function laneRowsToKeep(existingRows, rebuiltRows, ctx) {
  const { isLaneReview } = require('./trust-model');
  const leased = ctx.leasedShowIds || new Set();
  const openingDate = new Map((ctx.shows || []).map(s => [s.id, s.openingDate]));
  const key = (showId, url) => `${showId}|${ctx.canonicalUrl(url || '')}`;
  const rebuilt = new Set((rebuiltRows || []).filter(r => r && r.url).map(r => key(r.showId, r.url)));
  const textCache = new Map();
  const textUrls = (showId) => {
    if (!textCache.has(showId)) textCache.set(showId, new Set([...ctx.textUrls(showId)].map(u => ctx.canonicalUrl(u))));
    return textCache.get(showId);
  };
  const keep = [];
  const seen = new Set();
  for (const r of existingRows || []) {
    if (!r || !r.showId || !r.url || leased.has(r.showId)) continue;
    if (!openingDate.has(r.showId)) continue; // show removed from shows.json: let it go
    if (!isLaneReview(r, { openingDate: openingDate.get(r.showId) })) continue;
    const k = key(r.showId, r.url);
    if (rebuilt.has(k) || seen.has(k) || textUrls(r.showId).has(ctx.canonicalUrl(r.url))) continue;
    seen.add(k);
    keep.push(r);
  }
  return keep;
}

module.exports = { laneRowsToKeep };
