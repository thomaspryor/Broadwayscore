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
 * @returns {Array<{showId, file, outletId, firstSeenAt, promotedAt, latencyMin, hotSpan}>}
 */
function promotionLatencies(records, showsById, { since = null } = {}) {
  const sinceMs = since ? Date.parse(since) : -Infinity;
  const rows = [];
  for (const { showId, file, review } of records) {
    if (!review || review.bylineSource !== 'replay-pending-bylines') continue;
    const seen = Date.parse(review.firstSeenAt);
    const promoted = Date.parse(review.bylineExtractedAt);
    if (!Number.isFinite(seen) || !Number.isFinite(promoted)) continue;
    if (seen < sinceMs) continue;
    const show = showsById.get(showId);
    if (!show || !show.openingDate) continue;
    rows.push({
      showId,
      file,
      outletId: review.outletId || null,
      firstSeenAt: review.firstSeenAt,
      promotedAt: review.bylineExtractedAt,
      latencyMin: Math.max(0, Math.round((promoted - seen) / 60000)),
      hotSpan: inHotSpan(show, new Date(seen)),
    });
  }
  return rows.sort((a, b) => (a.firstSeenAt < b.firstSeenAt ? -1 : a.firstSeenAt > b.firstSeenAt ? 1 : 0));
}

/** Hot-span promotions slower than maxMin: each one is a review that sat invisible on press night. */
function slowHotSpanPromotions(rows, maxMin = DEFAULT_MAX_MIN) {
  return rows.filter((r) => r.hotSpan && r.latencyMin > maxMin);
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

module.exports = { promotionLatencies, slowHotSpanPromotions, median, DEFAULT_MAX_MIN };
