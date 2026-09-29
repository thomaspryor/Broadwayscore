/**
 * Health decisions for the weekly video-review pipeline (BRO-4323).
 *
 * From 2026-08-19 to 2026-09-28 every Weekly Video Reviews run extracted 0 of
 * 500+ transcripts (yt-dlp started needing curl_cffi for TikTok) and still
 * reported success, so no new video review was published for six weeks.
 * Discovery had the same shape: a creator whose feed listing errors is logged
 * and skipped, and the run stays green (tylernabinger, 2026-09-28).
 *
 * Pure functions so tests/unit/video-pipeline-health.test.mjs can require()
 * the real logic (CLAUDE.md §15).
 */

// Enough errored attempts on one platform, with zero successes, to call it an
// extractor outage rather than a few broken videos.
const MIN_ERRORED_ATTEMPTS = 10;

// Weekly cron: two missed scans in a row means a creator is silently dropping out.
const MAX_SCAN_AGE_DAYS = 15;

// yt-dlp errors that belong to one video (deleted, private, region-locked,
// members-only), not to the extractor. Failed videos are never cached and are
// retried every week, so without this a backlog of dead videos would read as
// an outage in any quiet week. Anything not matched here still counts.
const VIDEO_SPECIFIC_ERROR = /video unavailable|private video|this video (is|has been) (private|removed|unavailable|not available)|video (has been|was) removed|members[- ]only|not available in your country|geo.?restrict|age.?restrict|confirm your age|account (has been )?(terminated|banned)|this post is (unavailable|private)|status code 10204|status code 10216/i;

function isVideoSpecificError(message) {
  return VIDEO_SPECIFIC_ERROR.test(String(message || ''));
}

/**
 * @param {Record<string, {attempted:number, extracted:number, errored:number}>} byPlatform
 *   errored counts only attempts where yt-dlp printed an ERROR that is not
 *   video-specific (see isVideoSpecificError). Videos that simply have no
 *   captions, or are deleted/private, never count toward an outage.
 * @returns {string[]} platforms with an extraction outage
 */
function detectTranscriptOutages(byPlatform, minErrored = MIN_ERRORED_ATTEMPTS) {
  return Object.entries(byPlatform || {})
    .filter(([, s]) => s.extracted === 0 && s.errored >= minErrored)
    .map(([platform]) => platform);
}

/**
 * @param {{handle:string, scannedAt?:string}[]} discoveries one entry per CURRENT
 *   creator (from data/video-creators.json); a creator with no discovery file
 *   yet is passed as { handle } and counts as never scanned. Leftover files for
 *   removed creators must not be passed in.
 * @returns {{handle:string, scannedAt:string|null, ageDays:number|null}[]} creators not scanned recently
 */
function findStaleCreators(discoveries, now = new Date(), maxAgeDays = MAX_SCAN_AGE_DAYS) {
  const stale = [];
  for (const d of discoveries || []) {
    const t = d.scannedAt ? Date.parse(d.scannedAt) : NaN;
    if (Number.isNaN(t)) {
      stale.push({ handle: d.handle, scannedAt: d.scannedAt || null, ageDays: null });
      continue;
    }
    const ageDays = (now.getTime() - t) / 86400000;
    if (ageDays > maxAgeDays) stale.push({ handle: d.handle, scannedAt: d.scannedAt, ageDays: Math.floor(ageDays) });
  }
  return stale;
}

module.exports = { detectTranscriptOutages, findStaleCreators, isVideoSpecificError, MIN_ERRORED_ATTEMPTS, MAX_SCAN_AGE_DAYS };
