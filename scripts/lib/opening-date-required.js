/**
 * BRO-7929: an open or closed show must have an openingDate. Without one the
 * date guards cannot window its reviews (so a later same-title production's
 * reviews get parked on it as wrongProduction) and the page's "Opened ..." line
 * is blank. Legacy offenders are frozen in
 * data/audit/missing-opening-date-baseline.json (ratchet: new ones are errors).
 */
const fs = require('fs');
const path = require('path');

const BASELINE_PATH = path.join(__dirname, '..', '..', 'data', 'audit', 'missing-opening-date-baseline.json');

function needsOpeningDate(show) {
  return !!show && (show.status === 'open' || show.status === 'closed') && !show.openingDate;
}

function loadBaselineIds(p = BASELINE_PATH) {
  try { return new Set(JSON.parse(fs.readFileSync(p, 'utf8')).ids || []); } catch { return new Set(); }
}

/** @returns {{newOffenders: object[], baselined: object[]}} */
function findMissingOpeningDates(shows, baselineIds = loadBaselineIds()) {
  const off = (shows || []).filter(needsOpeningDate);
  return { newOffenders: off.filter((s) => !baselineIds.has(s.id)), baselined: off.filter((s) => baselineIds.has(s.id)) };
}

/**
 * Baseline ids that no longer need an openingDate (backfilled, removed, or now previews/upcoming).
 * The ratchet only shrinks, so these should be pruned from the baseline; until then a regression
 * on one of them would be silently tolerated. Advisory only: CI backfills dates on its own schedule.
 * @returns {string[]}
 */
function findStaleBaselineIds(shows, baselineIds = loadBaselineIds()) {
  const offenders = new Set((shows || []).filter(needsOpeningDate).map((s) => s.id));
  return [...baselineIds].filter((id) => !offenders.has(id)).sort();
}

module.exports = { BASELINE_PATH, needsOpeningDate, loadBaselineIds, findMissingOpeningDates, findStaleBaselineIds };
