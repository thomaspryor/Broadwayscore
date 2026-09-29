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

/**
 * @param {Record<string, {attempted:number, extracted:number, errored:number}>} byPlatform
 *   errored counts only attempts where yt-dlp printed an ERROR. Videos that
 *   simply have no captions are not errors and never count toward an outage.
 * @returns {string[]} platforms with an extraction outage
 */
function detectTranscriptOutages(byPlatform, minErrored = MIN_ERRORED_ATTEMPTS) {
  return Object.entries(byPlatform || {})
    .filter(([, s]) => s.extracted === 0 && s.errored >= minErrored)
    .map(([platform]) => platform);
}

/**
 * @param {{handle:string, scannedAt?:string}[]} discoveries
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

module.exports = { detectTranscriptOutages, findStaleCreators, MIN_ERRORED_ATTEMPTS, MAX_SCAN_AGE_DAYS };
