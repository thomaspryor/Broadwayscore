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
};
