'use strict';

const { isCommercialScope } = require('./commercial-scope');
const { nonprofitForVenue } = require('./nonprofit-venues');

/**
 * commercial-enrollment.js (BRO-5776)
 *
 * Which Broadway shows still need a commercial.json record. Enrollment used to
 * happen only inside opening-night-orchestrator.yml, so an announced show got
 * no record until its opening night (15 of 30 2026-27 productions had none on
 * 2026-10-21, which left the season report's nonprofit share and budget
 * averages blank). Every Broadway row that is announced, upcoming, in
 * previews or open is now enrolled as soon as it has a slug.
 *
 * Closed shows are not enrolled here: a closed show with no record is a
 * research-queue question, not a stub (the 2021-2026 seasons are complete).
 */

const ENROLLABLE_STATUSES = ['announced', 'upcoming', 'previews', 'open'];


function findUnenrolled(shows, commercialShows) {
  const have = commercialShows || {};
  const seen = new Set();
  const out = [];
  for (const show of shows || []) {
    if (!isCommercialScope(show) || !ENROLLABLE_STATUSES.includes(show.status)) continue;
    if (!show.slug || seen.has(show.slug)) continue;
    // Same two keys commercial-queue.js looks up: the canonical slug, or an id-keyed legacy row.
    if (Object.prototype.hasOwnProperty.call(have, show.slug) || (show.id && Object.prototype.hasOwnProperty.call(have, show.id))) continue;
    seen.add(show.slug);
    out.push(show);
  }
  return out;
}

// A rental to a commercial producer happens, so the venue only FLAGS a
// candidate for a human; it never sets designation or nonprofitOrg itself
// (memory: feedback_nonprofit_venue_vs_production).
function nonprofitHouseCandidate(show) {
  return nonprofitForVenue(show && show.venue);
}

module.exports = { ENROLLABLE_STATUSES, findUnenrolled, nonprofitHouseCandidate };
