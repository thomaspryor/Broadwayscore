'use strict';
/**
 * BRO-7283: the kill switch for the lane's comparative settle. Off unless the repo variable
 * LANE_COMPARATIVE_SETTLE_ENABLED is exactly 'true' (unset, empty, 'on', 'TRUE ' with junk: all off), so landing the
 * settle changes nothing until opening-night-lane-switch.yml turns it on. Read once at process start, so one night
 * cannot split. Pure.
 */
const VARIABLE = 'LANE_COMPARATIVE_SETTLE_ENABLED';
function parseSettleFlag(v) { return String(v == null ? '' : v).trim().toLowerCase() === 'true'; }
module.exports = { VARIABLE, parseSettleFlag };
