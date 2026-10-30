'use strict';
/**
 * The opening-night lane's discovery adapters, in pass order (BRO-5201 S4-T1). The production driver, the shadow run and
 * the rehearsal all build their list here, so none of them can quietly run a different lane: the shadow's hand-copied list
 * had lost the driver's Google News decoder, and the rehearsal never ran Playbill, Show Score or Talkin' Broadway.
 *
 * Every adapter that reads the clock gets the same `now`, so a virtual clock (rehearsal, replay) drives the Talkin'
 * Broadway probe throttle and the Google News decode budget too. `search` is the SERP backend; adaptersConfig.search,
 * when set, wins (the shadow's --adapters file and tests use it).
 */
const discovery = require('./discovery');

function laneAdapters({ showScoreGuards = {}, adaptersConfig = {}, search, decodeImpl = null, now = Date.now } = {}) {
  return [
    discovery.bwwRoundupAdapter(), discovery.dtliAdapter(), discovery.showScoreAdapter(showScoreGuards), discovery.playbillVerdictAdapter(),
    discovery.talkinBroadwayAdapter({ now }), discovery.googleNewsAdapter({ decodeImpl, now }),
    discovery.rssAdapter({ feeds: adaptersConfig.feeds }), discovery.sectionIndexAdapter({ outlets: adaptersConfig.outlets || [] }),
    discovery.serpAdapter({ search: adaptersConfig.search || search }),
  ];
}

module.exports = { laneAdapters };
