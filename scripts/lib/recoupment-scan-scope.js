/**
 * Which Broadway shows the recoupment detectors watch. Shared by:
 *   - scripts/scrape-recoupment-announcements.js (Friday SERP scan, SERP_SCOPE)
 *   - scripts/poll-trade-press-rss.js            (hourly RSS poller, RSS_SCOPE)
 * Both used to carry their own copy of a 28-365-days-since-opening window
 * (the poller's comment said it "mirrors Friday scraper"), so a show more
 * than a year past opening was invisible to BOTH (BRO-4623 item 5):
 *   - Purpose (opened 2025-03, closed 2025-08-31) announced recoupment on
 *     2026-06-04 via the revived NY State tax credit, ~9 months after closing
 *     (Deadline, Broadway News, Playbill, BroadwayWorld), and commercial.json
 *     still said Fizzle / recouped:false four months later.
 *   - every long-running unrecouped show (maybe-happy-ending, the-great-
 *     gatsby, operation-mincemeat, buena-vista-social-club, ...) could recoup
 *     at any time and would never have been detected.
 *
 * Scope now: Broadway (isCommercialScope), not already recouped, not a pure
 * nonprofit, and EITHER running (no upper age bound) OR closed recently
 * enough that a late recoupment is plausible. The two callers differ only in
 * cost: the RSS poller string-matches titles before any LLM call, so a wider
 * scope is free there; the SERP scan pays ~5 SERP calls per show per week.
 */

const { isCommercialScope } = require('./commercial-scope');
const { getRotationIndex } = require('./sample-show-pages');

// Nonprofit-org enhancement deals: LCT/MTC/Roundabout/Second Stage shows are
// "nonprofit" by designation but routinely carry commercial co-producers
// (Ragtime 2025 had Kirdahy / Greenblatt / Furman on top of LCT). Those
// enhancement investors DO recoup, and the announcement IS trade-press news.
// Pure non-enhancement nonprofits are skipped: they don't recoup.
const ENHANCEMENT_FRIENDLY_ORGS = new Set([
  'Lincoln Center Theater',
  'Manhattan Theatre Club',
  'Roundabout Theatre Company',
  'Second Stage Theater',
  'The Public Theater', // can transfer to Broadway with commercial enhancement
]);

const RUNNING_STATUSES = new Set(['open', 'previews', 'closing']);
const DAY_MS = 86_400_000;

// RSS: a title string-match gates every LLM call, so watch everything that
// has started performances, and closed shows for two years.
const RSS_SCOPE = Object.freeze({ minDaysSinceOpening: null, closedWithinDays: 730 });
// SERP: ~5 paid SERP calls per show per week. Running shows from four weeks
// after opening (nothing recoups in its first month), closed within a year.
const SERP_SCOPE = Object.freeze({ minDaysSinceOpening: 28, closedWithinDays: 365 });

function daysSince(dateStr, nowMs) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const t = Date.parse(dateStr);
  if (Number.isNaN(t)) return null;
  return Math.floor((nowMs - t) / DAY_MS);
}

/**
 * Decide whether one show is in the recoupment scan scope.
 *
 * @param {object} show - shows.json record
 * @param {object|undefined} commercialEntry - commercial.json shows[show.slug]
 * @param {object} [scope] - RSS_SCOPE or SERP_SCOPE (or a custom object)
 * @param {number|null} [scope.minDaysSinceOpening] - running shows must have
 *   opened (openingDate, else previewsStartDate) at least this many days ago;
 *   null means "has started performances at all"
 * @param {number} [scope.closedWithinDays] - closed shows must have closed
 *   within this many days
 * @param {number} [nowMs]
 * @returns {{include: boolean, reason: string}}
 */
function recoupmentScanDecision(show, commercialEntry, scope = SERP_SCOPE, nowMs = Date.now()) {
  if (!show) return { include: false, reason: 'no show record' };
  if (!isCommercialScope(show)) return { include: false, reason: `not Broadway (${show.category})` };
  const c = commercialEntry || {};
  if (c.recouped === true) return { include: false, reason: 'already recouped' };
  if (c.designation === 'Nonprofit' && !ENHANCEMENT_FRIENDLY_ORGS.has(c.nonprofitOrg)) {
    return { include: false, reason: 'pure nonprofit' };
  }

  if (RUNNING_STATUSES.has(show.status)) {
    const started = daysSince(show.previewsStartDate || show.openingDate, nowMs);
    if (started === null || started < 0) return { include: false, reason: 'performances not started' };
    if (scope.minDaysSinceOpening == null) return { include: true, reason: `running (${show.status})` };
    const opened = daysSince(show.openingDate || show.previewsStartDate, nowMs);
    if (opened === null || opened < scope.minDaysSinceOpening) {
      return { include: false, reason: `opened ${opened}d ago (< ${scope.minDaysSinceOpening}d)` };
    }
    return { include: true, reason: `running, opened ${opened}d ago` };
  }

  if (show.status === 'closed') {
    const closed = daysSince(show.closingDate, nowMs);
    if (closed === null) {
      // A show closes on or after it opens, so one that opened within the
      // window also closed within it. The old 28-365-day opening filter kept
      // these; dropping them would hide a recent closure whose closingDate
      // simply hasn't been filled in yet.
      const opened = daysSince(show.openingDate || show.previewsStartDate, nowMs);
      if (opened !== null && opened >= 0 && opened <= scope.closedWithinDays) {
        return { include: true, reason: `closed (no closingDate), opened ${opened}d ago` };
      }
      return { include: false, reason: 'closed with no closingDate' };
    }
    if (closed < 0) return { include: false, reason: 'closingDate in the future' };
    if (closed > scope.closedWithinDays) {
      return { include: false, reason: `closed ${closed}d ago (> ${scope.closedWithinDays}d)` };
    }
    return { include: true, reason: `closed ${closed}d ago` };
  }

  return { include: false, reason: `status=${show.status}` };
}

/**
 * @param {object[]} shows - shows.json shows array
 * @param {object} commercialShows - commercial.json `shows` map (slug-keyed)
 * @param {object} [scope]
 * @param {number} [nowMs]
 * @returns {object[]} the in-scope show records
 */
function pickRecoupmentCandidates(shows, commercialShows, scope = SERP_SCOPE, nowMs = Date.now()) {
  const cMap = commercialShows || {};
  return (shows || []).filter((s) => recoupmentScanDecision(s, s && cMap[s.slug], scope, nowMs).include);
}

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

/**
 * The order to scan candidates in this run. The Friday SERP scan stops at its
 * --time-budget-min and defers the rest "to next run", but a fixed order
 * (shows.json order) deferred the SAME tail shows every week, so they were
 * never scanned at all (review finding, BRO-4623: the wider scope took the
 * list from 26 to 35 shows against a scan that already ran ~14 min of 20).
 *
 * Sorted by slug for reproducibility, then rotated to start at
 * weekIndex * stride. The stride is about half the list and coprime with its
 * length, so every start position comes round, and as long as one run gets
 * through at least half the list plus two, no show is deferred two weeks in
 * a row (checked for every list length 2-300 in the test).
 * Stateless: no scan-history file to keep in sync.
 *
 * @param {object[]} candidates - show records with a slug
 * @param {number} [weekIndex] - monotonic week number (sample-show-pages.getRotationIndex)
 * @returns {object[]} a new array, same members
 */
function rotateScanOrder(candidates, weekIndex = getRotationIndex()) {
  const list = [...(candidates || [])].sort((a, b) => String(a && a.slug).localeCompare(String(b && b.slug)));
  const n = list.length;
  if (n < 2) return list;
  let stride = Math.max(1, Math.floor(n / 2));
  while (gcd(stride, n) !== 1) stride--;
  const start = (((weekIndex * stride) % n) + n) % n;
  return [...list.slice(start), ...list.slice(0, start)];
}

module.exports = {
  ENHANCEMENT_FRIENDLY_ORGS,
  RSS_SCOPE,
  SERP_SCOPE,
  recoupmentScanDecision,
  pickRecoupmentCandidates,
  rotateScanOrder,
};
