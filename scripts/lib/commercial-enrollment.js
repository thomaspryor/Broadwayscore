'use strict';

const { isCommercialScope } = require('./commercial-scope');

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

// Houses a Broadway nonprofit owns or runs. A rental to a commercial producer
// happens, so the venue only FLAGS a candidate for a human; it never sets
// designation or nonprofitOrg on its own (memory: feedback_nonprofit_venue_vs_production).
const NONPROFIT_HOUSE_ORG = {
  'Vivian Beaumont Theater': 'Lincoln Center Theater',
  'Mitzi E. Newhouse Theater': 'Lincoln Center Theater',
  'Samuel J. Friedman Theatre': 'Manhattan Theatre Club',
  'Todd Haimes Theatre': 'Roundabout Theatre Company',
  'American Airlines Theatre': 'Roundabout Theatre Company',
  'Stephen Sondheim Theatre': 'Roundabout Theatre Company',
  'Studio 54': 'Roundabout Theatre Company',
  'Helen Hayes Theater': 'Second Stage Theater',
  'Hayes Theater': 'Second Stage Theater',
};

function findUnenrolled(shows, commercialShows) {
  const have = commercialShows || {};
  const seen = new Set();
  const out = [];
  for (const show of shows || []) {
    if (!isCommercialScope(show) || !ENROLLABLE_STATUSES.includes(show.status)) continue;
    if (!show.slug || seen.has(show.slug)) continue;
    if (Object.prototype.hasOwnProperty.call(have, show.slug)) continue;
    seen.add(show.slug);
    out.push(show);
  }
  return out;
}

function nonprofitHouseCandidate(show) {
  return NONPROFIT_HOUSE_ORG[show && show.venue] || null;
}

module.exports = { ENROLLABLE_STATUSES, NONPROFIT_HOUSE_ORG, findUnenrolled, nonprofitHouseCandidate };
