// Pure decisions for scripts/discover-tour-stop-reviews.js (BRO-4656): which
// tour stops to search, the query and date window for each, and whether an
// ingested review's publish date belongs to the stop it was found for.
//
// A national tour's reviews come from local papers in the city it is playing,
// published while it is there. The weekly regional SERP job searches each tour
// once ("<title>" national tour review), which finds the few outlets that write
// "national tour" in a headline and misses the Denver Post's "Review: Wicked".
// Here each stop gets its own "<title>" review <city> query, windowed to that
// engagement.

const DAY = 24 * 60 * 60 * 1000;
// Stops that opened within this many days are searched every run (reviews keep
// arriving through the engagement); older stops are searched once, newest first.
const RECENT_DAYS = 28;
// A stop review is published from a week before opening (previews, early
// press) to a month after the stop closes.
const WINDOW_BEFORE_DAYS = 7;
const WINDOW_AFTER_DAYS = 30;

function cityName(city) {
  return String(city || '').split(',')[0].trim();
}

function stopKey(tourId, stop) {
  return `${tourId}|${stop.start}|${cityName(stop.city)}`;
}

// A recent stop is searched again once a week while it plays; an older stop is
// retried (ingest error, cap cut it short) at most MAX_ATTEMPTS runs.
const RESEARCH_DAYS = 6;
const MAX_ATTEMPTS = 3;

/**
 * The stops due this run. `tours` is the list of tour shows to consider,
 * `schedules` the data/tour-schedules.json `tours` map, `searched` the state's
 * { [stopKey]: { at, done, attempts } } map. Returns recent stops not searched
 * in the last week, then up to `backfill` older stops not yet done, newest first.
 */
function selectDueStops(tours, schedules, searched, { now = new Date(), backfill = 0 } = {}) {
  const recent = [];
  const older = [];
  const t = now.getTime();
  for (const show of tours) {
    const stops = ((schedules || {})[show.id] || {}).stops || [];
    for (const stop of stops) {
      const start = Date.parse(stop.start);
      const end = Date.parse(stop.end || stop.start);
      // An end before the start is a bad schedule row; its window means nothing.
      if (!stop.city || isNaN(start) || start > t || isNaN(end) || end < start) continue;
      const key = stopKey(show.id, stop);
      const prev = (searched || {})[key];
      const row = { show, stop, key };
      // Recent: opened in the last RECENT_DAYS, or still playing / closed
      // under two weeks ago (a seven-week Boston run keeps getting reviewed).
      if (t - start <= RECENT_DAYS * DAY || t - end <= 14 * DAY) {
        if (!prev || t - Date.parse(prev.at) >= RESEARCH_DAYS * DAY) recent.push({ ...row, why: 'recent' });
      } else if (!prev || (!prev.done && (prev.attempts || 0) < MAX_ATTEMPTS)) {
        older.push({ ...row, why: 'backfill' });
      }
    }
  }
  older.sort((a, b) => (a.stop.start < b.stop.start ? 1 : a.stop.start > b.stop.start ? -1 : 0));
  return recent.concat(older.slice(0, Math.max(0, backfill)));
}

function buildStopQuery(show, stop) {
  const city = cityName(stop.city);
  return city ? `"${show.title}" review ${city}` : null;
}

function buildStopDateRange(stop, now = new Date()) {
  const start = Date.parse(stop.start);
  const end = Date.parse(stop.end || stop.start);
  const dateMin = new Date(start - WINDOW_BEFORE_DAYS * DAY);
  const dateMax = new Date(Math.min(end + WINDOW_AFTER_DAYS * DAY, now.getTime() + DAY));
  return { dateMin, dateMax };
}

/** The window as ingest-review-from-url.js --date-window takes it. */
function stopDateWindowArg(stop) {
  const { dateMin, dateMax } = buildStopDateRange(stop, new Date(8640000000000000));
  return `${dateMin.toISOString().slice(0, 10)},${dateMax.toISOString().slice(0, 10)}`;
}

// A city query in a stop window also finds reviews of the screen version
// (Wicked: For Good opened during the Buffalo stop). Title and URL path name
// it outright; a stage review's snippet often mentions "the movie", so only
// screen-release phrases count there (a bare "box office" is the theatre's:
// "The box office is at 650 Main St").
const SCREEN_TITLE_RE = /\b(?:movie|film|cinema)\b/i;
const STAGE_RE = /\b(?:stage|tour(?:ing)?|theat(?:er|re)|broadway)\b/i;
const SCREEN_SNIPPET_RE = /\b(?:in theaters (?:now|nationwide|everywhere)|now streaming|(?:weekend|opening) box office|box office (?:opening|haul|debut)|movie review|film review)\b/i;
const SCREEN_PATH_RE = /\/(?:movies?|films?|streaming|videos?)\//i;
function looksLikeScreenVersion(result) {
  const title = String(result.title || '');
  let pathname = '';
  try { pathname = new URL(result.url).pathname; } catch { /* no url */ }
  return (SCREEN_TITLE_RE.test(title) && !STAGE_RE.test(title))
    || SCREEN_SNIPPET_RE.test(String(result.description || result.snippet || ''))
    || SCREEN_PATH_RE.test(pathname);
}

/**
 * Whether an unregistered domain's result is safe to ingest under a
 * provisional outlet: its title names the show and calls itself a review.
 * Registered outlets skip this (their pages are known review sources).
 */
function unregisteredLooksLikeStopReview(show, result) {
  const name = String(show.title || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const title = String(result.title || '');
  if (!name || !/\breview/i.test(title)) return false;
  const whole = (flags) => new RegExp(`(?:^|[^\\w])${name}(?:[^\\w]|$)`, flags).test(title);
  // A short title is a common word ("Six Flags", "Boop"): it must match in the
  // show's own casing or sit next to a theatre word.
  if (String(show.title).length <= 5) return whole('') || (whole('i') && /\b(?:musical|stage|tour(?:ing)?|theat(?:er|re))\b/i.test(title));
  return whole('i');
}

const { isOverseasHost } = require('./domain-filters');

module.exports = {
  RECENT_DAYS, WINDOW_BEFORE_DAYS, WINDOW_AFTER_DAYS, MAX_ATTEMPTS,
  stopKey, selectDueStops, buildStopQuery, buildStopDateRange, stopDateWindowArg, looksLikeScreenVersion, isOverseasHost, unregisteredLooksLikeStopReview,
};
