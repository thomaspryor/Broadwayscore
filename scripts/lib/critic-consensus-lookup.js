'use strict';

// Shared read path for critic-consensus.json's per-show shape. Previously
// hand-rolled independently in send-opening-night-broadcast.js and inline in
// opening-night-broadcast.yml's overdue-alert step (BRO-227 adversarial
// review 2026-08-26 flagged the duplication as a drift risk — a field rename
// in one copy silently stops matching in the other).
function getShowConsensusText(consensus, showId, slug) {
  const consensusShows = (consensus && consensus.shows) || consensus || {};
  const showConsensus = consensusShows[showId] || (slug && consensusShows[slug]);
  return (showConsensus && (showConsensus.text || showConsensus.consensus)) || null;
}

module.exports = { getShowConsensusText };
