'use strict';

/**
 * selectDeployedCoverageTargets — target set for audit-deployed-coverage.js
 * (card #639, cousin of #627's standingOutlets fix in
 * audit-opening-night-coverage.js).
 *
 * Window is bounded on BOTH sides: `status === 'open'` (evergreens, no date
 * bound needed) OR an opening within the last `days` days AND not in the
 * future. A show that has not opened yet cannot have reviews, so including
 * it does not surface a gap — it pads the denominator with a structural
 * true and burns a network fetch for nothing.
 *
 * ET, not UTC: openingDate is a bare YYYY-MM-DD authored in show-local time,
 * and toISOString() rolls over at 8pm ET — which would exclude a show that
 * opened today ET for the last four hours of the UTC day.
 */
function selectDeployedCoverageTargets(shows, { days = 21, nowMs = Date.now() } = {}) {
  const cutoff = new Date(nowMs - days * 86400000).toISOString().split('T')[0];
  const todayStr = new Date(nowMs).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  return (shows || []).filter((s) =>
    s.status === 'open' || (s.openingDate && s.openingDate >= cutoff && s.openingDate <= todayStr));
}

module.exports = { selectDeployedCoverageTargets };
