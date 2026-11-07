'use strict';

const { titleTokens, jaccard } = require('./title-match');
const { isLondonMarket } = require('./venue-classification');

/**
 * Build the theatr-coverage.json flagged list: unmatched Theatr shows whose
 * title fuzzy-matches one of our open/recent shows that lacks Theatr data.
 * Extracted from scrape-theatr-audience.js so it's unit-testable without a
 * live Theatr auth token (scripts/lib/*.test.mjs pattern, CLAUDE.md rule 15).
 *
 * London-market shows are excluded from the candidate pool: Theatr's catalog
 * is Broadway/Off-Broadway only (eventCategory is always 'Broadway' or
 * 'Off & Off-Off Broadway' — no West End category exists), so a West End show
 * can never legitimately match a Theatr listing. Without this, any West End
 * show that shares a title with an earlier NYC production of the same work
 * (an Off-Broadway-to-West-End transfer) false-positives every run (The
 * Jonathan Larson Project, BRO-303, 2026-08-13).
 *
 * @param {Array<object>} shows shows.json shows array
 * @param {object} audienceBuzz loaded audience-buzz.json ({ shows: {...} })
 * @param {Array<object>} unmatched Theatr shows not matched by matchTheatrToShows
 * @param {number} jaccardThreshold minimum token-set similarity to flag (default 0.6)
 * @returns {Array<object>} flagged entries, sorted by watched desc
 */
function buildTheatrCoverageFlags(shows, audienceBuzz, unmatched, jaccardThreshold = 0.6) {
  const candidates = shows
    .filter(s => !audienceBuzz.shows[s.id]?.sources?.theatr)
    .filter(s => { const o = s.openingDate || s.previewsStartDate; return !o || o >= '2015-01-01'; })
    .filter(s => !isLondonMarket(s.category))
    .map(s => ({ s, t: titleTokens(s.title), year: parseInt((s.openingDate || '').slice(0, 4)) }));

  const flagged = [];
  for (const u of unmatched) {
    const uTokens = titleTokens(u.name || '');
    if (!uTokens.size) continue;
    let best = null;
    for (const c of candidates) {
      if (!c.t.size) continue;
      const j = jaccard(uTokens, c.t);
      if (j < jaccardThreshold) continue;
      if (!best || j > best.j) best = { showId: c.s.id, showTitle: c.s.title, showYear: c.year, j };
    }
    if (best) flagged.push({
      theatrName: u.name,
      eventCategory: u.eventCategory,
      watched: u.totalWatchedUsers,
      ratingsCount: u.totalWatchedUsers,
      ourShowId: best.showId,
      ourTitle: best.showTitle,
      ourYear: best.showYear || null,
      jaccard: Number(best.j.toFixed(2)),
    });
  }
  flagged.sort((a, b) => (b.watched || 0) - (a.watched || 0));
  return flagged;
}

module.exports = { buildTheatrCoverageFlags };
