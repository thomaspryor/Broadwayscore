/**
 * TodayTix show-page runtime extraction.
 *
 * IMPORTANT: TodayTix's REST API (api.todaytix.com/api/v2/shows/{id}) returns a
 * `runningTime` object that can be STALE — the web page renders a separate
 * Contentful CMS field (`runTimeAndIntermission`) which is what users see and
 * what actually gets updated. Discovered 2026-07-20: Birthright (TT 45341) API
 * said 90 min while the page correctly said "3hr 30min. Incl. 2 Intermissions."
 *
 * Always treat the PAGE value as authoritative; use the API only as fallback.
 *
 * Usage:
 *   const { extractRunTimeDisplay, parseRunTimeDisplay } = require('./lib/todaytix-runtime');
 *   const display = extractRunTimeDisplay(html);   // "3hr 30min. Incl. 2 Intermissions."
 *   const parsed = parseRunTimeDisplay(display);   // { minutes: 210, runtime: "3h 30m", intermissions: 2 }
 */

/**
 * Pull the displayed run-time string out of a TodayTix show-page HTML document.
 * Tries the visible "Run time" section first, then the JSON-LD FAQ answer.
 *
 * Both strategies are scoped to the page's primary show. Deliberately NO raw
 * `"runTimeAndIntermission":"..."` fallback: pages embed that field for
 * carousel/related shows too, and an unscoped first-match can return a
 * DIFFERENT show's runtime. Failing closed (null → caller skips) is safer
 * than failing open with plausible wrong data.
 *
 * @param {string} html
 * @returns {string|null} e.g. "3hr 30min. Incl. 2 Intermissions."
 */
function extractRunTimeDisplay(html) {
  if (!html) return null;

  let m = html.match(/data-test-id="title-Run time"[^>]*>Run time<\/h2><div[^>]*>(?:<p>)?([^<]+)/);
  if (m) return m[1].trim();

  m = html.match(/"What is the running time of [^"]+","acceptedAnswer":\{"@type":"Answer","text":"[^"]*? runs for ([^"]+?)"/);
  if (m) return m[1].trim();

  return null;
}

/**
 * Parse a TodayTix run-time display string.
 *
 * Formats seen in the wild:
 *   "1hr 30min. No intermission."
 *   "2hr 30min. Incl. 1 intermission."
 *   "3hr 30min. Incl. 2 Intermissions."
 *   "1hr 50min. Incl. 15min intermission."   (the 15min is the interval length, not count)
 *   "2hr 50min. (Approx.) to 3hr 10min. Incl. 1 intermission."  (range — take lower bound)
 *   "2h 05min. Incl. 1 Interval"             (bare "h", London pages)
 *   "2 Hours and 20 Minutes, including 20 minute interval."
 *   "90min."
 *
 * Multi-part listings ("Part One: 2hr 45min. & Part Two: 2hr 35min.") return
 * null — no single number honestly describes them; leave existing data alone.
 *
 * @param {string} display
 * @returns {{minutes: number, runtime: string, intermissions: number|null}|null}
 */
function parseRunTimeDisplay(display) {
  if (!display) return null;
  const t = display.toLowerCase().trim();

  if (/part\s+(?:one|two|1|2)/.test(t)) return null;

  // Runtime lives in the first sentence; later sentences describe intermissions
  // (which can contain their own minute counts, e.g. "Incl. 15min intermission").
  const firstSegment = t.split(/\.\s|\.$/)[0];
  const hr = firstSegment.match(/(\d+)\s*h(?:ours?|rs?)?\b/);
  const min = firstSegment.match(/(\d+)\s*min/);
  if (!hr && !min) return null;

  const minutes = (hr ? parseInt(hr[1], 10) * 60 : 0) + (min ? parseInt(min[1], 10) : 0);
  if (minutes <= 0 || minutes > 300) return null;

  let intermissions = null;
  if (/no\s+(?:intermission|interval)/.test(t)) {
    intermissions = 0;
  } else {
    const count = t.match(/(\d+|one|two|three)\s+(?:intermissions?|intervals?)/);
    if (count) {
      const words = { one: 1, two: 2, three: 3 };
      intermissions = words[count[1]] ?? parseInt(count[1], 10);
    } else if (/intermission|interval/.test(t)) {
      intermissions = 1;
    }
  }

  return { minutes, runtime: formatCompactRuntime(minutes), intermissions };
}

/**
 * TodayTix's filler runningTime values. Listings with no real run time carry a
 * runningTime record with one of these displays while the page's
 * runTimeAndIntermission is null. Never a measurement: reject them.
 *
 * - 3hr 12min, two intermissions: Met Opera / ABT / La MaMa rows (BRO-5860, 10 rows 2026-10).
 * - 1hr 35mins (inc. interval): London default on 63 listings, 29 of them with a
 *   null page field (BRO-7594, 2026-11-16). Amadeus, West Side Story, Death of a
 *   Salesman were all stored as "1h 35m".
 * - 1hr 35min (no intermission): NYC default on 6 listings (Kiss of the Spider
 *   Woman's page says 2hr 30min incl. intermission) (BRO-7594).
 * - 4hrs (inc two intervals): NYC default on 5 listings, incl. Awake and Sing! (TT 45488) before previews; we
 *   stored "4h" and the FAQ told Google "4 hours with no intermission" (BRO-7594).
 *
 * A real show can run 1h 35m, so the London filler is matched on its exact
 * display string ("mins (inc. interval)"), not on minutes alone.
 */
const PLACEHOLDER_RUNNING_TIMES = [
  { minutes: 192, display: /^3\s*hrs?\s*12\s*min\.?\s*\(?incl(?:\.|uding)?\s*(?:two|2)\s*intermissions\)?\.?$/i },
  { minutes: 95, display: /^1\s*hr\s*35\s*mins\s*\(inc\.\s*interval\)$/i },
  { minutes: 95, display: /^1\s*hr\s*35\s*min\s*\(no\s*intermission\)$/i },
  { minutes: 240, display: /^4\s*hrs\s*\(inc\s*two\s*intervals\)$/i },
];

/**
 * True when a TodayTix runningTime ({minutes, display}) or a display string is
 * one of the filler values above.
 *
 * @param {{minutes?: number, display?: string}|string|null} rt
 * @returns {boolean}
 */
function isPlaceholderRunningTime(rt) {
  if (!rt) return false;
  const display = (typeof rt === 'string' ? rt : (rt.display || '')).trim();
  return PLACEHOLDER_RUNNING_TIMES.some(p => {
    if (typeof rt === 'object' && rt.minutes != null && rt.minutes !== p.minutes) return false;
    return p.display.test(display);
  });
}

/**
 * Statuses before the first performance. TodayTix's API runningTime for these
 * is a listing default far more often than a measurement (every BRO-7594 row
 * was pre-previews), so writers must take a run time for them only from the
 * show PAGE, never the API fallback.
 */
const PRE_PERFORMANCE_STATUSES = new Set(['announced', 'upcoming']);

/**
 * May the API runningTime be used as a fallback for this show?
 *
 * @param {object} show - shows.json entry
 * @param {{minutes?: number, display?: string}|null} apiRunningTime
 * @returns {boolean}
 */
function apiRuntimeTrusted(show, apiRunningTime) {
  if (!apiRunningTime || !apiRunningTime.minutes) return false;
  if (isPlaceholderRunningTime(apiRunningTime)) return false;
  if (show && PRE_PERFORMANCE_STATUSES.has(show.status)) return false;
  return true;
}

/**
 * Stored shows.json runtimes that are TodayTix fillers (BRO-5860, BRO-7594).
 * Value: true when the row is filler whatever its intermissions; false when only
 * a row with unknown intermissions is (writers dropped the filler's count).
 */
const STORED_FILLER_RUNTIMES = { '3h 12m': true, '1h 35m': false, '4h': false };

/**
 * Real run times that equal a stored filler. Each checked on the TodayTix page.
 * 2026-11-16 (BRO-7594): both pages read "1hr 35min." with no intermission note.
 */
const STORED_FILLER_EXEMPT = new Set(['spare-parts-off-broadway-2026', 'fishing-for-alaska-off-broadway-2026']);

/**
 * TodayTix-linked rows whose stored runtime is a filler value.
 *
 * @param {object[]} shows
 * @returns {string[]} "id (runtime)"
 */
function storedFillerRows(shows) {
  return shows
    .filter(s => s.todaytixId && Object.prototype.hasOwnProperty.call(STORED_FILLER_RUNTIMES, s.runtime) && !STORED_FILLER_EXEMPT.has(s.id))
    .filter(s => STORED_FILLER_RUNTIMES[s.runtime] || s.intermissions == null)
    .map(s => `${s.id} (${s.runtime})`);
}

/**
 * Parse our shows.json compact runtime format into minutes.
 * "1h 30m" → 90, "2h" → 120, "90m" → 90.
 *
 * @param {string} runtime
 * @returns {number|null}
 */
function parseCompactRuntime(runtime) {
  if (!runtime) return null;
  const m = runtime.trim().match(/^(?:(\d+)h)?\s*(?:(\d+)m)?$/);
  if (!m || (!m[1] && !m[2])) return null;
  return (m[1] ? parseInt(m[1], 10) * 60 : 0) + (m[2] ? parseInt(m[2], 10) : 0);
}

/**
 * Minutes → "3h 30m" / "2h" / "45m" (matches enrich-todaytix-runtimes.js format).
 */
function formatCompactRuntime(minutes) {
  if (minutes < 60) return minutes + 'm';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/**
 * Best-guess TodayTix page URL for a show. Prefers the stored todaytixUrl;
 * otherwise builds one from todaytixId using the market-correct city path
 * (London shows live under /london/, not /nyc/).
 *
 * @param {object} show - shows.json entry
 * @returns {string|null}
 */
function todaytixPageUrl(show) {
  if (show.todaytixUrl) return show.todaytixUrl;
  if (!show.todaytixId) return null;
  const city = ['west-end', 'off-west-end'].includes(show.category) ? 'london' : 'nyc';
  return `https://www.todaytix.com/${city}/shows/${show.todaytixId}`;
}

module.exports = {
  extractRunTimeDisplay,
  parseRunTimeDisplay,
  parseCompactRuntime,
  formatCompactRuntime,
  todaytixPageUrl,
  isPlaceholderRunningTime,
  apiRuntimeTrusted,
  storedFillerRows,
  PRE_PERFORMANCE_STATUSES,
};
