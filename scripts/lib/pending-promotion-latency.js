'use strict';

/**
 * How long did a press-night review sit in _pending/ (no byline) before it was
 * promoted? BRO-7032: TheaterMania's Unbelievers review was found at 03:39Z,
 * routed to _pending/, and only promoted by the NEXT poller run's pre-loop drain
 * at 04:33Z (54 min), so it missed the 11:55pm ET live deadline. The fix drains
 * every press-night-window show right after its poll, so a promotable stub found
 * in the press-night hot span should now be promoted within the same run.
 *
 * The evidence is already on each promoted file: firstSeenAt (discovery) and
 * bylineExtractedAt with bylineSource 'replay-pending-bylines' (promotion).
 */

const { inHotSpan } = require('./poller-loop-budget');

const DEFAULT_MAX_MIN = 45;

/**
 * @param {Array<{showId:string, file:string, review:object}>} records
 * @param {Map<string, object>} showsById
 * @param {{since?: string}} [opts]  only rows whose firstSeenAt >= since
 * Rows whose discovery clock cannot be trusted are returned with unknownClock: true and
 * never count as slow or as evidence: a stub with no firstSeenAt gets one stamped AT
 * refetch (pending-review-health.js), so firstSeenAt at/after pendingRefetchedAt, or
 * after the promotion, means the real wait is unknown. Duplicates (filed under another
 * review) are skipped: they were never the visible copy.
 * @returns {Array<{showId, file, outletId, firstSeenAt, promotedAt, latencyMs, latencyMin, hotSpan, unknownClock}>}
 */
function promotionLatencies(records, showsById, { since = null } = {}) {
  const sinceMs = since ? Date.parse(since) : -Infinity;
  const rows = [];
  for (const { showId, file, review } of records) {
    if (!review || review.bylineSource !== 'replay-pending-bylines') continue;
    if (review.duplicateOf) continue;
    const seen = Date.parse(review.firstSeenAt);
    const promoted = Date.parse(review.bylineExtractedAt);
    if (!Number.isFinite(seen) || !Number.isFinite(promoted)) continue;
    if (seen < sinceMs) continue;
    const refetched = Date.parse(review.pendingRefetchedAt);
    const unknownClock = promoted < seen || (Number.isFinite(refetched) && seen >= refetched);
    const show = showsById.get(showId);
    if (!show || !show.openingDate) continue;
    rows.push({
      showId,
      file,
      outletId: review.outletId || null,
      firstSeenAt: review.firstSeenAt,
      promotedAt: review.bylineExtractedAt,
      latencyMs: promoted - seen,
      latencyMin: Math.max(0, Math.round((promoted - seen) / 60000)),
      hotSpan: inHotSpan(show, new Date(seen)),
      unknownClock,
    });
  }
  return rows.sort((a, b) => (a.firstSeenAt < b.firstSeenAt ? -1 : a.firstSeenAt > b.firstSeenAt ? 1 : 0));
}

/** Hot-span promotions slower than maxMin: each one is a review that sat invisible on press night. */
function slowHotSpanPromotions(rows, maxMin = DEFAULT_MAX_MIN) {
  return rows.filter((r) => r.hotSpan && !r.unknownClock && r.latencyMs > maxMin * 60000);
}

/** Hot-span rows with a trustworthy clock: the evidence a recheck counts. */
function hotSpanEvidence(rows) {
  return rows.filter((r) => r.hotSpan && !r.unknownClock);
}

/**
 * Stubs still in _pending/ that were found in a press-night hot span and have waited longer
 * than maxMin as of `now`. Informational: a stub with no byline anywhere on the page can never
 * be promoted by the drain, so these are reported, not failed.
 */
function strandedHotSpanStubs(pendingRecords, showsById, { since = null, now = new Date(), maxMin = DEFAULT_MAX_MIN } = {}) {
  const sinceMs = since ? Date.parse(since) : -Infinity;
  const out = [];
  for (const { showId, file, review } of pendingRecords) {
    const seen = Date.parse(review && review.firstSeenAt);
    const show = showsById.get(showId);
    if (!Number.isFinite(seen) || seen < sinceMs || !show || !show.openingDate) continue;
    if (now.getTime() - seen <= maxMin * 60000) continue;
    if (!inHotSpan(show, new Date(seen))) continue;
    out.push({ showId, file, firstSeenAt: review.firstSeenAt, waitingMin: Math.round((now.getTime() - seen) / 60000) });
  }
  return out;
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

module.exports = { promotionLatencies, slowHotSpanPromotions, hotSpanEvidence, strandedHotSpanStubs, median, DEFAULT_MAX_MIN };
