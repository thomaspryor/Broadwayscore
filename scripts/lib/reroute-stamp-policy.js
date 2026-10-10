'use strict';

/**
 * Pure decisions for migrate-reroute-backlog.js --cross-market (BRO-2272).
 *
 * A cross-market move is matched on show-ID / year proximity only. Two
 * additional rules stop it from re-admitting a different production's review:
 *
 *   1. crossMarketDateGate: the review's publishDate must sit inside the
 *      target show's date window (not implausibly before its earliest date,
 *      not after its closing date + grace). 2024 West End reviews of "A View
 *      from the Bridge" were moved onto the 2026 Off-Broadway production
 *      because the IDs were 2 apart.
 *   2. stripBypassFlags: a cross-market move never writes allowEarlyDate /
 *      allowLateDate / wrongProductionOverride. Those flags bypass the date
 *      guards, so stamping them is what made the wrong move permanent.
 */

const { earliestShowDate } = require('./date-guard');
const { parseDate } = require('./date-utils');

const DAYS_BEFORE_START_GRACE = 60; // matches Path B in migrate-reroute-backlog.js
const DAYS_AFTER_CLOSING_GRACE = 180;

/**
 * Fails closed: a missing/guessed publishDate or a target with no start date
 * is "no corroboration", not a pass. priorRuns/tourLegs are deliberately not
 * honored: they would vouch for a different run of the same show.
 * @returns {{ ok: boolean, reason: string|null }}
 */
function crossMarketDateGate(review, targetShow) {
  if (!review || !targetShow) return { ok: false, reason: 'no-review-or-target' };
  const pub = parseDate(review.publishDate);
  if (!pub) return { ok: false, reason: 'no-publish-date' };
  if (review.dateSource === 'llm-scoring') return { ok: false, reason: 'publish-date-llm-guessed' };

  const start = parseDate(earliestShowDate(targetShow));
  if (!start) return { ok: false, reason: 'target-has-no-start-date' };
  const daysBefore = Math.round((start.getTime() - pub.getTime()) / 86400000);
  if (daysBefore > DAYS_BEFORE_START_GRACE) return { ok: false, reason: `publish-date-${daysBefore}d-before-target-window` };

  const closing = parseDate(targetShow.closingDate);
  if (closing) {
    const daysAfter = Math.round((pub.getTime() - closing.getTime()) / 86400000);
    if (daysAfter > DAYS_AFTER_CLOSING_GRACE) return { ok: false, reason: `publish-date-${daysAfter}d-after-target-closing` };
  }
  return { ok: true, reason: null };
}

const BYPASS_FLAGS = ['allowEarlyDate', 'allowLateDate', 'wrongProductionOverride',
  'wrongProductionOverrideReason', 'wrongProductionOverrideSetAt', 'wrongProductionOverrideSetBy'];

/** Remove every date/wrongProduction bypass flag from a file about to be moved cross-market. */
function stripBypassFlags(data) {
  for (const f of BYPASS_FLAGS) delete data[f];
  return data;
}

module.exports = { crossMarketDateGate, stripBypassFlags, BYPASS_FLAGS };
