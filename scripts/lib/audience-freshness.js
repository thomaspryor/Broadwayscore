/**
 * Shared "was this audience source touched recently?" check for the
 * audience-buzz scrapers (BRO-4215).
 *
 * The opening-night orchestrator re-dispatches update-reddit-sentiment.yml and
 * update-show-score.yml with the same opening-window shows ~7x/day. Those two
 * runs were ~67% and ~11% of ScrapingBee's billed credits (9/21-9/27), almost
 * all of it re-scraping data that had not changed since the previous dispatch.
 * Each scraper's --skip-fresh-hours=N drops shows whose source record was
 * written (or, for Reddit, cleanly attempted) within N hours.
 */
'use strict';

/**
 * Latest touch for one source of an audience-buzz record: the LATER of the
 * source's own `lastUpdated` and an optional top-level attempt stamp (e.g.
 * `redditLastAttempted`, written when a clean scrape found no data).
 * @param {object|undefined} buzzRecord - audienceBuzz.shows[id]
 * @param {string} source - key under buzzRecord.sources ('reddit', 'showScore', ...)
 * @param {string} [attemptField] - top-level attempt-stamp field, if the scraper writes one
 * @returns {number|null} epoch ms, or null if never touched
 */
function lastSourceTouchMs(buzzRecord, source, attemptField) {
  const rec = buzzRecord || {};
  const src = rec.sources && rec.sources[source];
  const times = [src && src.lastUpdated, attemptField ? rec[attemptField] : null]
    .filter(Boolean).map((t) => new Date(t).getTime()).filter((t) => !Number.isNaN(t));
  return times.length ? Math.max(...times) : null;
}

/**
 * True when the source was touched within `hours` of `nowMs`. hours <= 0
 * disables the skip (callers pass 0 to force a re-scrape).
 */
function isSourceFresh(buzzRecord, source, hours, { attemptField, nowMs = Date.now() } = {}) {
  if (!(hours > 0)) return false;
  const last = lastSourceTouchMs(buzzRecord, source, attemptField);
  return last !== null && nowMs - last < hours * 60 * 60 * 1000;
}

module.exports = { lastSourceTouchMs, isSourceFresh };
