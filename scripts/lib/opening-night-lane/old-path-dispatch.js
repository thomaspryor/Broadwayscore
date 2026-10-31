'use strict';
/**
 * The old-path dispatch for one show: opening-night-orchestrator.yml with the show and its market. Shared by the lane
 * watchdog (BRO-6621) and the lane switch rollback (BRO-6622) so both start the same run. market=auto would mean
 * "detect from cron time", which a dispatch does not have, so the market is always named. Pure.
 */
const marketFor = (show) => (show && show.market === 'west-end' ? 'west-end' : 'broadway');

/** `gh` argv for the dispatch. */
const oldPathDispatchArgs = (show) => ['workflow', 'run', 'opening-night-orchestrator.yml', '-f', `show_id=${show.id}`, '-f', `market=${marketFor(show)}`];

module.exports = { marketFor, oldPathDispatchArgs };
