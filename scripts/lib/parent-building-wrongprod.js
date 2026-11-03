/**
 * BRO-6923: pick the wrongProduction-flagged review files worth re-verifying
 * because the show is filed at a stage INSIDE a bigger building and the flag's
 * own reason names that building ("at the Young Vic", "National Theatre").
 * Pure: no I/O. The re-check itself is scripts/reverify-parent-building-wrongprod.js.
 */
const { parentBuildingOf } = require('./venue-aliases');
const { WRONG_PRODUCTION_CLEAR_MARKERS } = require('./review-write-guard');

function _reasonText(d) {
  const cv = (d && d.contentVerification) || {};
  return [d && d.wrongProductionReason, d && d.wrongProductionNote, cv.reasoning, cv.wrongProductionReason]
    .filter((x) => typeof x === 'string').join(' \n ');
}

function _mentions(text, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z])${esc}([^A-Za-z]|$)`, 'i').test(text);
}

/**
 * @param {object} show    shows.json entry (venue, category)
 * @param {object} record  review-texts file contents
 * @returns {{ candidate: boolean, parent?: string, why?: string }}
 */
function parentBuildingFlagCandidate(show, record) {
  const p = show && parentBuildingOf(show.venue, show.category);
  if (!p) return { candidate: false, why: 'venue is not a stage inside a bigger building' };
  if (!record || record.wrongProduction !== true) return { candidate: false, why: 'not flagged wrongProduction' };
  if (WRONG_PRODUCTION_CLEAR_MARKERS.some((k) => record[k] != null && record[k] !== false && record[k] !== '')
      || typeof record.humanReviewedWrongProduction === 'boolean') return { candidate: false, why: 'already cleared or a human reviewed the flag' };
  const text = _reasonText(record);
  const hit = p.parentNames.find((n) => _mentions(text, n));
  if (!hit) return { candidate: false, why: 'flag reason does not name the parent building' };
  return { candidate: true, parent: p.parent };
}

module.exports = { parentBuildingFlagCandidate };
