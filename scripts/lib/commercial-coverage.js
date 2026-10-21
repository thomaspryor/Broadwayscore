'use strict';

const { isCommercialScope } = require('./commercial-scope');
const { ENROLLABLE_STATUSES } = require('./commercial-enrollment');

// Use the same Broadway scope as the writers. Other markets intentionally
// have no commercial records and must not dilute the launch-readiness audit.
// Announced and upcoming shows count too (BRO-5776): the season report reads
// their records months before opening night.
function getOpenCommercialCoverage(shows, commercialShows) {
  const withCommercial = [];
  const withoutCommercial = [];
  for (const show of shows) {
    if (!isCommercialScope(show) || !ENROLLABLE_STATUSES.includes(show.status)) continue;
    const covered = Object.prototype.hasOwnProperty.call(commercialShows, show.slug);
    (covered ? withCommercial : withoutCommercial).push(show);
  }
  return { withCommercial, withoutCommercial };
}

module.exports = { getOpenCommercialCoverage };
