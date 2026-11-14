/**
 * postponed-production-audit.js (BRO-4913)
 *
 * Shared sweep: open/previews shows with 0 reviews past the grace window whose
 * official page (supplied by the injected `getPageText`) shows a future launch
 * date. No network or scraper import here: callers inject page text, so
 * fixture-driven audits stay out of the scraper-spend ledger's reach.
 */
'use strict';

const { evaluatePostponed } = require('./postponed-production-detector');

/**
 * @param {{shows: object[]}} showsData
 * @param {object} opts
 * @param {Date} opts.now
 * @param {{reviews: object[]}|null} opts.reviewsData  null/unreadable → fail closed (returns none)
 * @param {(show: object) => Promise<string|null>} opts.getPageText  may throw (counted as a fetch failure)
 * @param {boolean} [opts.demote]  mutate matching shows to upcoming/futureDate (caller saves)
 * @param {number} [opts.budgetMs]  wall-clock budget for page fetches
 * @returns {Promise<{postponed: object[], fetchFailures: number, skipped: string|null}>}
 */
async function findPostponedShows(showsData, opts) {
  const { now, reviewsData, getPageText, demote = false, budgetMs = 90000 } = opts;
  if (!reviewsData || !Array.isArray(reviewsData.reviews)) {
    return { postponed: [], fetchFailures: 0, skipped: 'reviews.json unreadable (fail closed)' };
  }
  const counts = new Map();
  for (const r of reviewsData.reviews) counts.set(r.showId, (counts.get(r.showId) || 0) + 1);
  const deadline = Date.now() + budgetMs;
  const postponed = [];
  let fetchFailures = 0;
  let skipped = null;
  for (const show of showsData.shows) {
    if (!['open', 'previews'].includes(show.status) || !show.openingDate) continue;
    if ((counts.get(show.id) || 0) > 0) continue;
    // Prefilter before any fetch: probe the date window with a synthetic future cue.
    if (!evaluatePostponed(show, { now, reviewCount: 0, pageText: 'coming january 1, 2099' })) continue;
    if (Date.now() > deadline) { skipped = `fetch budget ${budgetMs}ms hit; remaining shows skipped`; break; }
    let pageText = null;
    try { pageText = await getPageText(show); } catch (e) { fetchFailures++; }
    const hit = evaluatePostponed(show, { now, reviewCount: 0, pageText });
    if (!hit) continue;
    const entry = { id: show.id, title: show.title, openingDate: show.openingDate, futureDate: hit.futureDate, reason: hit.reason, demoted: false };
    if (demote) {
      show.status = 'upcoming';
      show.openingDate = hit.futureDate;
      show.previewsStartDate = hit.futureDate;
      show.openingDateSource = 'official-site';
      show.openingDateNote = `Auto-demoted (BRO-4913): official page shows ${hit.futureDate}`;
      entry.demoted = true;
    }
    postponed.push(entry);
  }
  return { postponed, fetchFailures, skipped };
}

module.exports = { findPostponedShows };
