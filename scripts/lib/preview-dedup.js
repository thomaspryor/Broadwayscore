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

/**
 * Workflow-side gate: "should this show be blocked because a preview was already
 * sent for it within the rolling window?" Used by opening-night-broadcast.yml's
 * "Check already broadcast" step, which previously checked `sentAt.startsWith(today)`
 * and silently double-sent at UTC rollover (2026-04-11 02:09 UTC incident).
 *
 * This is the "per-show in a batch" check — different semantics from
 * checkPreviewDedup, which compares review counts for a whole broadcastKey combo.
 * Here we just need: "has any preview for this showId gone out recently?"
 *
 * Default window is 24h — matches the script-side checkPreviewDedup hard gate. The
 * 2026-04-11 incident had a 14h gap between the first and duplicate preview, so a
 * shorter window wouldn't have caught it.
 *
 * @param {object} sentData - Parsed opening-night-sent.json (either {shows:{...}} or {...}).
 * @param {string} showId   - Show ID to check (matched as a substring of any preview key).
 * @param {number} windowMs - Rolling window in ms. Default 24h.
 * @param {number} now      - Clock override for tests.
 * @returns {boolean} true if a recent preview exists and the show should be skipped.
 */
function hasRecentPreviewForShow(sentData, showId, windowMs = 24 * 3_600_000, now = Date.now()) {
  const shows = (sentData && sentData.shows) || sentData || {};
  for (const [key, value] of Object.entries(shows)) {
    if (!key.startsWith('preview:')) continue;
    if (!key.includes(showId)) continue;
    const sentAt = value && value.sentAt;
    if (!sentAt) continue;
    const ageMs = now - new Date(sentAt).getTime();
    if (ageMs >= 0 && ageMs < windowMs) return true;
  }
  return false;
}

/**
 * Workflow-side gate: "have we already fired the overdue alert for this show
 * within the rolling window?" Previously `sent[alertKey].sentAt.startsWith(today)`,
 * same UTC-rollover bug class.
 *
 * The alert writes use a stable key (`overdue-alert:${id}`, no date suffix), so
 * there's always at most one entry per show. We just check the age of that entry.
 *
 * @param {object} sentData - Parsed opening-night-sent.json.
 * @param {string} showId   - Show ID.
 * @param {number} windowMs - Rolling window. Default 24h.
 * @param {number} now      - Clock override for tests.
 * @returns {boolean} true if a recent alert exists and the alert should be skipped.
 */
function hasRecentOverdueAlert(sentData, showId, windowMs = 24 * 3_600_000, now = Date.now()) {
  const shows = (sentData && sentData.shows) || sentData || {};
  const entry = shows['overdue-alert:' + showId];
  const sentAt = entry && entry.sentAt;
  if (!sentAt) return false;
  const ageMs = now - new Date(sentAt).getTime();
  return ageMs >= 0 && ageMs < windowMs;
}

module.exports = { checkPreviewDedup, hasRecentPreviewForShow, hasRecentOverdueAlert };
