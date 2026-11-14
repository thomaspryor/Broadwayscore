'use strict';

/**
 * outlet-feed-reconcile.js (BRO-5358)
 *
 * Pure decision function behind scripts/outlet-feed-reconcile.js. Nothing alerted
 * when an outlet's feed carried a review of a running show we never ingested: Fish
 * (WP Theater, opened 2026-10-11) had two real reviews in RSS feeds the day after
 * opening that sat unfiled for ~2 days (BRO-5326). Off-Broadway shows have no
 * aggregator roundup, so the aggregator-based completeness audits were blind to it.
 *
 * reconcileFeedItems() compares feed items against the corpus we already hold and
 * returns the items that look like a review of a recently opened show but whose URL
 * is in no review file for that show (flagged or not). It is ADVISORY (CLAUDE.md
 * §19): it reports, it never files.
 *
 * Two confidence levels:
 *  - 'matched'  the real poller matcher (findMatchingShows, including the credit and
 *               venue rules) accepts the item for the show, so the poller SHOULD have
 *               filed it. Every matched gap is a pipeline miss worth a look.
 *  - 'possible' the matcher declined it, but the whole show title appears in the
 *               headline/slug/description AND the item was published within the show's
 *               opening window. Looser, so it can be noise ("fish and chips"); listed
 *               apart and never counted in the headline number.
 */

const { findMatchingShows } = require('./outlet-listing-helpers');
const { normalizeTitle } = require('./title-match');
const { normalizeUrl } = require('./url-utils');
const { toDateMs } = require('./date-utils');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 7;
// A review can predate opening night (press performances) by a few days.
const PRE_OPENING_DAYS = 3;

/** Comparison key for "is this the same article": scheme, www, query and fragment ignored. */
function urlKey(url) {
  return normalizeUrl(String(url || '').trim())
    .replace(/#.*$/, '')
    .replace(/^https?:\/\/(www\.)?/, '')
    .replace(/\/$/, '');
}

function slugOf(url) {
  try { return new URL(url).pathname; } catch { return String(url || ''); }
}

/**
 * Shows that opened within the last windowDays (and not in the future beyond a day).
 * @param {Array} shows
 * @param {number} nowMs
 * @param {number} windowDays
 */
function recentlyOpenedShows(shows, nowMs, windowDays = DEFAULT_WINDOW_DAYS) {
  return (shows || []).filter((s) => {
    if (!s || (s.status !== 'open' && s.status !== 'previews')) return false;
    const t = Date.parse(s.openingDate || '');
    return !Number.isNaN(t) && t <= nowMs + DAY_MS && nowMs - t <= windowDays * DAY_MS;
  });
}

function titleInText(show, item) {
  const norm = normalizeTitle(String(show.title || '').replace(/[-‐‑‒–—_/]+/g, ' '));
  if (!norm) return false;
  const hay = ` ${normalizeTitle(`${item.headline || ''} ${slugOf(item.url).replace(/[-‐‑‒–—_/.]+/g, ' ')} ${item.description || ''}`.replace(/[-‐‑‒–—]/g, ' '))} `;
  return hay.includes(` ${norm} `);
}

// "Fish" in "the best fish and chips" is not a theatre item; a possible gap needs a
// theatre word or the show's venue next to the title.
const THEATRE_WORD_RE = /\b(review|reviews|theat(?:er|re)|stage|play|musical|premiere|off[- ]broadway|broadway|west end|production|cast)\b/i;
function looksTheatrical(show, item) {
  const text = `${item.headline || ''} ${slugOf(item.url).replace(/[-_/.]+/g, ' ')} ${item.description || ''}`;
  if (THEATRE_WORD_RE.test(text)) return true;
  const venue = normalizeTitle(String(show.venue || ''));
  return !!venue && ` ${normalizeTitle(text)} `.includes(` ${venue} `);
}

function inOpeningWindow(show, item, windowDays) {
  const open = Date.parse(show.openingDate || '');
  const pub = toDateMs(item.publishDate);
  if (Number.isNaN(open) || Number.isNaN(pub)) return false;
  return pub >= open - PRE_OPENING_DAYS * DAY_MS && pub <= open + (windowDays + 3) * DAY_MS;
}

/**
 * @param {Object}   input
 * @param {Array}    input.activeShows     all open/previews shows (the matcher needs the
 *                                         full set for its same-venue and title guards)
 * @param {Array}    input.targetShows     shows to reconcile (recentlyOpenedShows(...) or an explicit one)
 * @param {Array}    input.items           feed items {outletId, url, headline, publishDate, description}
 * @param {Object}   input.knownUrls       showId -> iterable of URLs already held (any review
 *                                         file for the show, flagged or not) or durably rejected
 * @param {number}   [input.nowMs]
 * @param {number}   [input.windowDays]
 * @returns {{gaps: Array, matchedCount: number, possibleCount: number}}
 */
function reconcileFeedItems({ activeShows, targetShows, items, knownUrls = {}, nowMs = Date.now(), windowDays = DEFAULT_WINDOW_DAYS }) {
  const known = new Map();
  for (const show of targetShows) {
    known.set(show.id, new Set([...(knownUrls[show.id] || [])].map(urlKey)));
  }
  const gaps = [];
  const seen = new Set();
  for (const item of items || []) {
    if (!item || !item.url) continue;
    const matched = findMatchingShows(item.headline, slugOf(item.url), activeShows, item.description || '', { nowMs, publishDate: item.publishDate });
    const matchedIds = new Set(matched.map((s) => s.id));
    for (const show of targetShows) {
      if (known.get(show.id).has(urlKey(item.url))) continue;
      let level = null;
      if (matchedIds.has(show.id)) {
        // A title match says nothing about WHICH production: standard.co.uk's old
        // "Midnight at the Never Get" review matched the new Midnight (live run,
        // 2026-10-14). A dated item must fall inside the opening window; an undated
        // one (sitemaps, some listings) can only be "possible".
        const pub = toDateMs(item.publishDate);
        const open = toDateMs(show.openingDate);
        if (Number.isNaN(pub)) level = 'possible';
        else if (!Number.isNaN(open) && pub < open - PRE_OPENING_DAYS * DAY_MS) continue;
        else level = 'matched';
      }
      if (!level && titleInText(show, item) && inOpeningWindow(show, item, windowDays) && looksTheatrical(show, item)) level = 'possible';
      if (!level) continue;
      const key = `${show.id}|${urlKey(item.url)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      gaps.push({
        showId: show.id,
        title: show.title,
        level,
        outletId: item.outletId || null,
        url: item.url,
        headline: item.headline || null,
        publishDate: item.publishDate || null,
      });
    }
  }
  gaps.sort((a, b) => (a.level === b.level ? a.showId.localeCompare(b.showId) || String(a.url).localeCompare(String(b.url)) : a.level === 'matched' ? -1 : 1));
  return {
    gaps,
    matchedCount: gaps.filter((g) => g.level === 'matched').length,
    possibleCount: gaps.filter((g) => g.level === 'possible').length,
  };
}

/**
 * Plain-English digest lines for a reconcile result (one per show with matched gaps).
 * @param {Array} gaps
 * @param {number} [limit]
 * @returns {Array<{title: string, detail: string}>}
 */
function digestItems(gaps, limit = 5) {
  const byShow = new Map();
  for (const g of gaps || []) {
    if (g.level !== 'matched') continue;
    if (!byShow.has(g.showId)) byShow.set(g.showId, { title: g.title, outlets: [] });
    byShow.get(g.showId).outlets.push(g.outletId || 'an outlet');
  }
  return [...byShow.values()].slice(0, limit).map(({ title, outlets }) => ({
    title,
    detail: `${outlets.length} review${outlets.length === 1 ? '' : 's'} in outlet feeds not ingested (${[...new Set(outlets)].join(', ')})`,
  }));
}

/**
 * Opening-night checklist verdict for one show's reconcile report (the CLI's --json output).
 * Advisory: never 'fail'. 'skip' when the reconcile could not look (no corpus, no output).
 * @returns {{status: 'pass'|'warn'|'skip', detail: string}}
 */
function readinessVerdict(report) {
  if (!report || !Array.isArray(report.shows)) return { status: 'skip', detail: 'feed reconcile produced no report (advisory)' };
  if (report.shows.length === 0) {
    const why = (report.skipped && report.skipped[0] && report.skipped[0].reason) || 'no show reconciled';
    return { status: 'skip', detail: `feed reconcile did not run: ${why}` };
  }
  const matched = (report.gaps || []).filter((g) => g.level === 'matched');
  const possible = (report.gaps || []).filter((g) => g.level === 'possible');
  if (matched.length > 0) {
    const list = matched.slice(0, 3).map((g) => `${g.outletId}: ${g.url}`).join('; ');
    return { status: 'warn', detail: `${matched.length} outlet feed item(s) look like reviews of this show but are in no review file: ${list}${matched.length > 3 ? ' ...' : ''}. Ingest with scripts/ingest-review-from-url.js.` };
  }
  const feeds = `${report.itemsScanned} items from ${report.feedsChecked} feeds`;
  return { status: 'pass', detail: possible.length ? `no matched gaps (${feeds}); ${possible.length} looser title mention(s) to eyeball in data/audit/outlet-feed-reconcile.json` : `no outlet feed item is missing from the corpus (${feeds})` };
}

module.exports = { readinessVerdict, reconcileFeedItems, recentlyOpenedShows, digestItems, urlKey, DEFAULT_WINDOW_DAYS };
