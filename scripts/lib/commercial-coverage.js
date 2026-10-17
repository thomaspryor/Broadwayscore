'use strict';

const { isCommercialScope } = require('./commercial-scope');

// Use the same Broadway scope as the writers. Other markets intentionally
// have no commercial records and must not dilute the launch-readiness audit.
function getOpenCommercialCoverage(shows, commercialShows) {
  const withCommercial = [];
  const withoutCommercial = [];
  for (const show of shows) {
    if (!isCommercialScope(show) || !['open', 'previews'].includes(show.status)) continue;
    const covered = Object.prototype.hasOwnProperty.call(commercialShows, show.slug);
    (covered ? withCommercial : withoutCommercial).push(show);
  }
  return { withCommercial, withoutCommercial };
}

module.exports = { getOpenCommercialCoverage };
