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

const { evaluateDatePlausibility } = require('./date-plausibility');
const { parseDate } = require('./date-utils');

const DAYS_AFTER_CLOSING_GRACE = 180;

/**
 * @returns {{ ok: boolean, reason: string|null }}
 */
function crossMarketDateGate(review, targetShow) {
  if (!review || !targetShow) return { ok: false, reason: 'no-review-or-target' };
  const pub = parseDate(review.publishDate);
  if (!pub) return { ok: false, reason: 'no-publish-date' };

  // Strip the bypass/flag fields: the moved review is judged on its date alone.
  const probe = { publishDate: review.publishDate, dateSource: review.dateSource };
  const plaus = evaluateDatePlausibility({ review: probe, show: targetShow });
  if (plaus.implausible) return { ok: false, reason: `publish-date-${plaus.daysBefore}d-before-target-window` };

  const closing = parseDate(targetShow.closingDate);
  if (closing) {
    const daysAfter = Math.round((pub.getTime() - closing.getTime()) / 86400000);
    if (daysAfter > DAYS_AFTER_CLOSING_GRACE) return { ok: false, reason: `publish-date-${daysAfter}d-after-target-closing` };
  }
  return { ok: true, reason: null };
}

const BYPASS_FLAGS = ['allowEarlyDate', 'allowLateDate', 'wrongProductionOverride'];

/** Remove every date/wrongProduction bypass flag from a file about to be moved cross-market. */
function stripBypassFlags(data) {
  for (const f of BYPASS_FLAGS) delete data[f];
  return data;
}

module.exports = { crossMarketDateGate, stripBypassFlags, BYPASS_FLAGS, DAYS_AFTER_CLOSING_GRACE };
