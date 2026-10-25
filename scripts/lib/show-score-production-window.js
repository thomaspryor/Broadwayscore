/**
 * Does a Show Score page belong to THIS production? (BRO-5866)
 *
 * Show Score keeps one page per production, and a same-title production of a
 * different play reuses the plain slug. L.B. Browne's Safe House (Theatre Row,
 * Sept 2026) was mapped to /off-broadway-shows/safe-house, which is Enda
 * Walsh's Safe House (St. Ann's Warehouse, Feb 2025): title match, no year in
 * the heading, so titlesMatch() and page-validator's year checks (heading
 * year, or 4+ years off) all passed, and the 2025 page's audience score and
 * critic reviews landed on the 2026 show.
 *
 * The dates on the page are the signal those checks lack. Every critic and
 * audience review on a production's page is written while that production
 * runs, so when nearly all of them sit well before our previews began (or
 * long after our run closed), the page is another production's. Needs a few
 * dates to judge; with too few it says ok rather than guess.
 *
 * Pure: callers pass the html (or date strings already extracted, e.g.
 * show-score.json criticReviews[].date) and the shows.json row. Used by
 * scrape-show-score-audience.js (discovery + scrape), extract-show-score-
 * reviews.js (archive extraction) and audit-show-score-urls.js (the sweep).
 */
'use strict';

const { parseDate } = require('./date-utils');

const DAY_MS = 24 * 60 * 60 * 1000;
// Reviews before previews begin: a few press previews or festival tryouts at
// most. 60 days of slack keeps those while catching a prior production.
const EARLY_SLACK_DAYS = 60;
// Reviews after closing: late write-ups and audience reviews trail a run;
// a year past closing is another production.
const LATE_SLACK_DAYS = 365;
const MIN_DATES = 3;
// Share of dates that must fall outside the window. Below 1 so one stray
// date (a news item, a cast-change note) can't save a wrong page.
const OUTSIDE_SHARE = 0.9;

// Show Score prints review dates as "February 21st, 2025" / "Feb 21, 2025".
const DATE_RE = /\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+\d{1,2}(?:st|nd|rd|th)?,\s*\d{4}\b/g;

function extractPageDates(html) {
  if (!html) return [];
  return String(html).match(DATE_RE) || [];
}

function toMs(value) {
  if (!value) return null;
  const d = parseDate(String(value));
  if (!d || Number.isNaN(d.getTime())) return null;
  const year = d.getUTCFullYear();
  if (year < 1950 || year > 2100) return null;
  return d.getTime();
}

function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * @param {string[]} dateStrings  review dates from the page
 * @param {{id?: string, previewsStartDate?: string, openingDate?: string, closingDate?: string, priorRuns?: object[], tourLegs?: object[]}} show
 * @returns {{ok: boolean, reason: string, outside?: number, total?: number}}
 */
function checkProductionWindow(dateStrings, show) {
  const startMs = toMs(show && (show.previewsStartDate || show.openingDate));
  if (startMs == null) return { ok: true, reason: 'no production start date to compare' };
  const dates = (dateStrings || []).map(toMs).filter((ms) => ms != null).sort((a, b) => a - b);
  if (dates.length < MIN_DATES) return { ok: true, reason: `only ${dates.length} dated reviews` };

  // A date inside a declared prior run or tour leg is this production's own
  // earlier staging (review-guards.js reasonFromParsedUrlDate, same rule):
  // a return engagement with no row of its own keeps its page. A run marked
  // inheritReviews:false is a separate production and does not count.
  const { isWithinPriorRun, isWithinTourLeg } = require('./wrong-production-autoclear');
  const ownEarlierRun = (ms) => isWithinPriorRun(new Date(ms), show.priorRuns) || isWithinTourLeg(new Date(ms), show.tourLegs);

  const earliestOk = startMs - EARLY_SLACK_DAYS * DAY_MS;
  const before = dates.filter((ms) => ms < earliestOk && !ownEarlierRun(ms)).length;
  if (before / dates.length >= OUTSIDE_SHARE) {
    return {
      ok: false,
      reason: `${before}/${dates.length} page dates (latest ${isoDay(dates[dates.length - 1])}) predate this production's start ${isoDay(startMs)} by over ${EARLY_SLACK_DAYS} days: another production's page`,
      outside: before,
      total: dates.length,
    };
  }

  const closeMs = toMs(show.closingDate);
  if (closeMs != null && closeMs >= startMs) {
    const latestOk = closeMs + LATE_SLACK_DAYS * DAY_MS;
    const after = dates.filter((ms) => ms > latestOk && !ownEarlierRun(ms)).length;
    if (after / dates.length >= OUTSIDE_SHARE) {
      return {
        ok: false,
        reason: `${after}/${dates.length} page dates (earliest ${isoDay(dates[0])}) come over ${LATE_SLACK_DAYS} days after this production closed ${isoDay(closeMs)}: another production's page`,
        outside: after,
        total: dates.length,
      };
    }
  }

  return { ok: true, reason: `${dates.length} page dates fit the production window` };
}

// Reviewed BRO-5866 sweep hits where the page IS this production: an
// open-ended run, or a return engagement with no separate row for the first
// run, whose page still carries the original reviews. Keep this short; a new
// entry needs a reason a reviewer can check.
const SAME_PRODUCTION = {
  'drunk-shakespeare-off-broadway-2022': 'open-ended run since 2014; one continuing production',
  'friends-the-musical-parody-off-broadway-2022': 'same touring parody production remounted; page still live',
  'my-neighbour-totoro-west-end-2025': 'RSC production transferred from the Barbican; Show Score West End page',
  'slave-play-2021': 'return engagement of the 2019 Broadway production; no separate 2019 row',
  'patriots-west-end-2023': 'Almeida 2022 production transferred; no separate Almeida row',
  'the-ocean-at-the-end-of-the-lane-west-end-2019': 'NT Dorfman production; page carries its 2021-23 West End transfer, no row of its own',
  'hold-on-to-your-butts-off-broadway-2026': 'Rhinoceros Theatre production remounted at SoHo Playhouse; no row for the 2024 run',
  'mrs-stern-wanders-the-prussian-state-library-luna-stage-off-broadway-2026': 'Luna Stage production transferred to 59E59; page named for Luna Stage',
  'the-dead-1904-off-broadway-2026': 'Irish Rep production remounted at the same venue; no rows for 2016-18',
  'a-christmas-carol-the-musical-off-broadway-2026': 'annual Players Theatre remount; no rows for earlier seasons',
  'the-boy-at-the-back-of-the-class-west-end-2026': 'same touring production; no row for the 2024 run',
};

function slugTokens(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !['the', 'theatre', 'theater', 'and'].includes(t));
}

// Show Score names a page after its venue when it runs one production at
// several houses (mexodus-daryl-roth-theatre). A page named for OUR venue was
// made for our run, even when it shows the reviews it carried over.
function slugNamesVenue(url, venue) {
  const slug = String(url || '').replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop() || '';
  const venueTokens = slugTokens(venue);
  if (venueTokens.length === 0) return false;
  const slugSet = new Set(slugTokens(slug.replace(/-/g, ' ')));
  return venueTokens.every((t) => slugSet.has(t));
}

function exemptionFor(show, url) {
  if (!show) return null;
  if (SAME_PRODUCTION[show.id]) return SAME_PRODUCTION[show.id];
  if (url && slugNamesVenue(url, show.venue)) return `page is named for this production's venue (${show.venue})`;
  return null;
}

/**
 * The gate writers call: a window mismatch that no exemption covers.
 * dates: page dates (strings). Returns {ok, reason, exempt?}.
 */
function checkShowScoreProduction(dates, show, url) {
  const result = checkProductionWindow(dates, show);
  if (result.ok) return result;
  const exempt = exemptionFor(show, url);
  if (exempt) return { ok: true, exempt: true, reason: `${result.reason} (exempt: ${exempt})` };
  return result;
}

function checkPageProductionWindow(html, show, url) {
  return checkShowScoreProduction(extractPageDates(html), show, url);
}

module.exports = {
  checkProductionWindow,
  checkShowScoreProduction,
  checkPageProductionWindow,
  exemptionFor,
  slugNamesVenue,
  SAME_PRODUCTION,
  extractPageDates,
  EARLY_SLACK_DAYS,
  LATE_SLACK_DAYS,
};
