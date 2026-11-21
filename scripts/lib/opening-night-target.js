'use strict';

/**
 * Which shows the opening-night checklist picks up on its own
 * (opening-night-checklist.js). Pure.
 */

function isWithinTwoDays(openingDate, now) {
  if (!openingDate) return false;
  const diff = Math.abs(new Date(openingDate).getTime() - now.getTime());
  return diff <= 2 * 24 * 60 * 60 * 1000;
}

/**
 * A show opening within two days, except a national tour: its openingDate is
 * its first stop, not a press night, so no BWW/DTLI roundup is coming and stub
 * remediation would chase nothing (BRO-4724). --show still checks one by hand.
 */
function isOpeningNightTarget(show, now) {
  return !!show && show.category !== 'tour' && isWithinTwoDays(show.openingDate, now);
}

module.exports = { isWithinTwoDays, isOpeningNightTarget };
