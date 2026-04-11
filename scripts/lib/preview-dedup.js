/**
 * Preview-send dedup logic for opening-night broadcasts.
 *
 * Extracted as a pure function so it can be unit-tested without sending emails.
 *
 * Incident (2026-04-11, ~02:09 UTC): the previous implementation used a UTC-date-
 * keyed lookup (`preview:{market}:{showId}:{YYYY-MM-DD}`). A preview sent at
 * 2026-04-10 12:16 UTC wrote key `...:2026-04-10`; a second preview run at
 * 2026-04-11 02:09 UTC (still the same evening in ET — 10:09 PM on Apr 10) looked
 * up key `...:2026-04-11`, found nothing, and sent a duplicate preview for the
 * SAME show with the SAME review count. Two previews landed in the owner's inbox.
 *
 * Root cause: UTC date buckets don't match the real "broadcast day." US opening-
 * night reviews drop at 10–11 PM ET, which is 02–03 UTC the next day. Every re-run
 * after 8 PM ET crosses the UTC midnight boundary and gets a fresh dedup key.
 *
 * Fix: scan ALL `preview:{market}:{showId}:*` entries for the show combination,
 * find the most recent one by `sentAt`, and apply a rolling 24-hour window plus
 * the existing 3-new-review threshold. Date strings are no longer load-bearing.
 *
 * Returns a decision object:
 *   { action: 'send' }                                       — no recent preview
 *   { action: 'send', lastPreview, hoursSince }              — last preview is >24h old
 *   { action: 'skip', lastPreview, hoursSince, newReviews }  — recent preview, insufficient new reviews
 *   { action: 'resend', lastPreview, hoursSince, newReviews }— recent preview, 3+ new reviews
 */
function checkPreviewDedup(sentData, broadcastKey, currentReviewCount, now = Date.now()) {
  const shows = (sentData && sentData.shows) || {};
  const previewKeyPrefix = `preview:${broadcastKey}:`;

  // Scan every tracked entry for this show combination and pick the most recent.
  let lastPreview = null;
  for (const [key, value] of Object.entries(shows)) {
    if (!key.startsWith(previewKeyPrefix)) continue;
    if (!value || !value.sentAt) continue;
    if (!lastPreview || value.sentAt > lastPreview.sentAt) {
      lastPreview = value;
    }
  }

  if (!lastPreview) {
    return { action: 'send' };
  }

  const lastSentMs = new Date(lastPreview.sentAt).getTime();
  const hoursSince = (now - lastSentMs) / 3_600_000;

  // Rolling 24h window: older than that, always allow a fresh preview.
  if (hoursSince >= 24) {
    return { action: 'send', lastPreview, hoursSince };
  }

  const previousReviewCount = lastPreview.reviewCount || 0;
  const newReviews = currentReviewCount - previousReviewCount;

  if (newReviews < 3) {
    return { action: 'skip', lastPreview, hoursSince, newReviews };
  }

  return { action: 'resend', lastPreview, hoursSince, newReviews };
}

module.exports = { checkPreviewDedup };
