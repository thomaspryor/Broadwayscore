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


// BRO-5366: TikTok intermittently answers a profile listing with an empty body
// ("Failed to parse JSON"), which skipped 4 creators for 15-23 days while the
// other creators scanned fine in the same run. One retry round with a pause
// recovers most of these; a creator that fails every attempt still goes stale.
const SCAN_ATTEMPTS = 3;

/** The last yt-dlp ERROR line of a failed execSync, else the first line of the message. */
function scanErrorLine(err) {
  const out = `${err && err.stdout ? err.stdout : ''}\n${err && err.stderr ? err.stderr : ''}`;
  const lines = out.split('\n').filter(l => /ERROR:/.test(l));
  if (lines.length) return lines[lines.length - 1].trim().substring(0, 300);
  return String((err && err.message) || err || '').split('\n')[0].substring(0, 300);
}

/**
 * Run fn() up to `attempts` times. fn throws on failure and returns on success.
 * @returns {{ok:boolean, value?:any, error?:string, attempts:number}}
 */
function runWithRetries(fn, { attempts = SCAN_ATTEMPTS, pause = () => {} } = {}) {
  let error = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      return { ok: true, value: fn(i), attempts: i };
    } catch (err) {
      error = scanErrorLine(err);
      // A timeout already burned the whole budget (300s); retrying it x3 would
      // push 10 creators past the job's 180-minute limit.
      if (err && (err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM')) return { ok: false, error, attempts: i };
      if (i < attempts) { try { pause(i); } catch { /* a failed pause must not abort the scan run */ } }
    }
  }
  return { ok: false, error, attempts };
}

// BRO-5537: yt-dlp fetches TikTok's /api/creator/item_list/ through its plain
// urllib handler even though curl_cffi is installed (only the profile page is
// impersonated). TikTok answers most of those with a 270-byte text/html bot
// page, read as "Failed to parse JSON": 2 of 16 attempts listed anything, and
// 5 of 6 TikTok creators failed all 3 retries on 2026-10-16. --impersonate
// sends every request through curl_cffi: 12 of 12 attempts, and all 7 TikTok
// creators listed 300 of 300 videos. YouTube lists fine without it.
const TIKTOK_IMPERSONATE_TARGET = 'chrome';

/**
 * The yt-dlp command that lists a creator's feed for discover-videos.js.
 * @param {{platform:string, url:string, limit:number}} opts platform is the
 *   creator's primaryPlatform; anything but 'youtube' is listed as TikTok.
 */
function buildListingCommand({ platform, url, limit }) {
  const impersonate = platform === 'youtube' ? '' : ` --impersonate ${TIKTOK_IMPERSONATE_TARGET}`;
  return `yt-dlp${impersonate} --flat-playlist --print "%(id)s\t%(title)s\t%(upload_date)s\t%(duration_string)s\t%(view_count)s" "${url}" --playlist-items 1-${limit} --sleep-interval 1 2>&1`;
}

module.exports = { buildListingCommand, TIKTOK_IMPERSONATE_TARGET, runWithRetries, scanErrorLine, SCAN_ATTEMPTS, detectTranscriptOutages, findStaleCreators, isVideoSpecificError, MIN_ERRORED_ATTEMPTS, MAX_SCAN_AGE_DAYS };
