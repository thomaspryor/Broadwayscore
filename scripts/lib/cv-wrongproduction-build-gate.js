'use strict';

/**
 * BRO-7296: hold verifier-flagged wrong-production reviews off the site at build time.
 *
 * The opening-night check cv-wrongproduction-unhandled fires at email time, long after
 * any of the rebuild's many wrongProduction auto-clears has released the file and let it
 * ship (Blueberries 2026-11-10, 43 shows at opening, 223 lifetime). This is the same
 * per-file decision moved to the door: rebuild-all-reviews.js asks it for every file that
 * survived the earlier exclusions and drops the ones it holds.
 *
 * Pure: no I/O of its own beyond what the reused check helpers do (handledReason may read a
 * duplicateOf sibling, so the caller passes the file path). The rebuild's own
 * deliberate-keep carve-outs (ensemble advisory, venue carve-out, own-cast, lane, allowEarlyDate)
 * are computed by the caller and passed in `carveouts` so this module needs no rebuild state.
 *
 * Clear flags follow the check exactly: only a boolean true from a human/curator clears.
 * The rebuild's own stamp is a STRING (`wrongProductionAutoCleared: 'rebuild: dateless-revival
 * hold released ...'`), which is the bypass this gate exists to close, so a string never clears.
 *
 * Grandfathering: a row already live in the previous reviews.json is never held, so no live
 * score moves on the day the gate arms; only rows that would newly ship are held.
 */

const { handledReason, isCorroboratedTemporalOverride, CLEAR_FLAGS } =
  require('./opening-night-checks/cv-wrongproduction-unhandled.check');

/**
 * Keys under which a shipped row is recognised. A row with a url is recognised by that url only (an
 * outlet+critic key would let a second, different-url file from the same critic ride on the live row's
 * slot, the exact case the gate exists for). A url-less row falls back to outlet+critic. Both sides are
 * canonicalised with the rebuild's own normalisers (injected), because live rows store canonical outlet
 * ids and display-normalised critic names while the review-texts file holds the raw ones.
 */
const ident = (x) => x;
const { displayCriticName } = require('./critic-display-name');
// BRO-7310: live rows carry the DISPLAY name (displayCriticName: typo/alias fixes, placeholder -> null) while the
// review-texts file holds the raw byline, so an aliased critic never matched on normalizeCriticName alone and
// url-less files missed grandfathering. Both sides go through the same display step; null/placeholder -> ''.
function criticKey(norm, rawCritic, outlet) {
  const n = (norm.critic || ident)(rawCritic);
  if (!n) return '';
  let d = null;
  try { d = displayCriticName(String(n), outlet || null); } catch (_) { d = null; }
  return (d == null ? '' : d).toString();
}
function shippedKeys(showId, row, norm = {}) {
  const url = (norm.url || ident)(row.url);
  const outlet = (norm.outlet || ident)(row.outletId || row.outlet) || '';
  const critic = criticKey(norm, row.criticName, outlet);
  if (url) return [`${showId}::url::${url}`];
  if (!outlet) return [];
  // A live row whose critic was dropped (placeholder/Unknown) is stored with a null critic: match it too.
  return [`${showId}::oc::${outlet}::${critic}`, `${showId}::oc::${outlet}::`];
}

/** Set of grandfather keys from a parsed reviews.json `reviews` array. A live row is keyed BOTH ways (its url and its outlet+critic). */
function buildGrandfatherSet(reviews, norm = {}) {
  const set = new Set();
  for (const r of Array.isArray(reviews) ? reviews : []) {
    if (!r || !r.showId) continue;
    const url = (norm.url || ident)(r.url);
    if (url) set.add(`${r.showId}::url::${url}`);
    const outlet = (norm.outlet || ident)(r.outletId);
    if (outlet) set.add(`${r.showId}::oc::${outlet}::${criticKey(norm, r.criticName, outlet)}`);
  }
  return set;
}

function isGrandfathered(grandfather, showId, data, norm = {}) {
  if (!grandfather) return false;
  return shippedKeys(showId, data, norm).some((k) => grandfather.has(k));
}

/**
 * @param {object} data review-texts file as the rebuild holds it in memory
 * @param {object} show shows.json record
 * @param {object} opts
 * @param {string} opts.filePath path of the review-texts file (handledReason may read a sibling)
 * @param {{url?:Function,outlet?:Function,critic?:Function}} [opts.normalizers] same normalisers passed to buildGrandfatherSet
 * @param {Set<string>|null} opts.grandfather from buildGrandfatherSet; null = gate off (fail open)
 * @param {object} [opts.carveouts] booleans the rebuild already computed: advisory, venueCarveout, ownCast, lane
 * @returns {{hold: boolean, reason: string|null}}
 */
function decideCvWrongProductionHold(data, show, opts = {}) {
  const none = { hold: false, reason: null };
  const cv = data && data.contentVerification;
  if (!cv || cv.wrongProduction !== true) return none;
  if (!opts.grandfather) return none; // no previous reviews.json to grandfather against: stand down loudly in the caller
  if (CLEAR_FLAGS.some((f) => data[f] === true)) return { hold: false, reason: 'clear-flag' };
  if (data.wrongProduction === false && data.wrongProductionManualClear === true) return { hold: false, reason: 'manual-clear' };
  const c = opts.carveouts || {};
  if (data.allowEarlyDate || data.allowCrossMarket || c.advisory || c.venueCarveout || c.ownCast || c.lane) {
    return { hold: false, reason: 'rebuild-carveout' };
  }
  if (isCorroboratedTemporalOverride(data, show)) return { hold: false, reason: 'corroborated-temporal-override' };
  const handled = handledReason(data, show, opts.filePath || '', { exactShipped: true });
  if (handled) return { hold: false, reason: handled };
  return isGrandfathered(opts.grandfather, opts.showId || (show && show.id), data, opts.normalizers)
    ? { hold: false, reason: 'grandfathered' }
    : { hold: true, reason: 'cv-wrongproduction-unhandled' };
}

module.exports = { decideCvWrongProductionHold, buildGrandfatherSet, isGrandfathered, shippedKeys, criticKey };
