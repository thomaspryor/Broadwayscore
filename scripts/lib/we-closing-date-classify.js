/**
 * we-closing-date-classify.js
 *
 * Pure decision function for audit-we-closing-dates.js. Mirrors the delta
 * classification inline in audit-closing-dates.js (Broadway) so the same
 * extension/ambiguous/new-closing/match logic applies to West End shows,
 * extracted to a lib per CLAUDE.md rule 15 rather than re-derived inline.
 *
 * @param {object} opts
 * @param {string|null} opts.stored - stored closingDate 'YYYY-MM-DD', or null
 * @param {string} opts.extracted - extracted announced date 'YYYY-MM-DD'
 * @param {number} [opts.ambiguousDeltaThresholdDays=30]
 * @param {number} [opts.maxAutoExtensionDays=180]
 * @returns {{action: 'NEW_CLOSING_NEEDS_REVIEW'|'EXTENSION'|'EXTENSION_EXCEEDS_CAP_NEEDS_REVIEW'|'NEEDS_HUMAN_REVIEW'|'MATCH', delta: number|null}}
 */
function classifyWeClosingDelta(opts) {
  const {
    stored,
    extracted,
    ambiguousDeltaThresholdDays = 30,
    maxAutoExtensionDays = 180,
  } = opts;

  if (!extracted) throw new Error('classifyWeClosingDelta: extracted date is required');

  if (!stored) {
    return { action: 'NEW_CLOSING_NEEDS_REVIEW', delta: null };
  }

  const delta = Math.round((new Date(extracted) - new Date(stored)) / 86400000);

  if (delta > 0 && delta > maxAutoExtensionDays) {
    return { action: 'EXTENSION_EXCEEDS_CAP_NEEDS_REVIEW', delta };
  }
  if (delta > 0) {
    return { action: 'EXTENSION', delta };
  }
  if (delta < 0 && Math.abs(delta) > ambiguousDeltaThresholdDays) {
    return { action: 'NEEDS_HUMAN_REVIEW', delta };
  }
  return { action: 'MATCH', delta };
}

/**
 * Single routing point for an audit result: which report bucket it lands in and
 * whether it may be WRITTEN to shows.json. The "extension-only write" rule:
 * ONLY an EXTENSION on a show without human protection writes a closingDate.
 * New-closing candidates (WE "Booking until" is often a booking tranche for an
 * open-ended run), over-cap extensions, shrinks, possibly-closed, matches and
 * errors never write. The main loop must use this so a new case cannot start
 * writing without failing the test in we-closing-date-classify.test.mjs.
 *
 * @param {string} action - result.action from auditOneShow
 * @param {boolean} canWrite - canWriteClosingDate(show) (false = human-protected)
 * @returns {{bucket: string, write: boolean}}
 */
function routeWeAuditResult(action, canWrite) {
  switch (action) {
    case 'ERROR': return { bucket: 'errors', write: false };
    case 'NEW_CLOSING_NEEDS_REVIEW': return { bucket: 'newClosings', write: false };
    case 'EXTENSION': return { bucket: 'extensions', write: canWrite === true };
    case 'EXTENSION_EXCEEDS_CAP_NEEDS_REVIEW':
    case 'NEEDS_HUMAN_REVIEW':
    case 'POSSIBLY_CLOSED_NEEDS_REVIEW': return { bucket: 'ambiguous', write: false };
    default: return { bucket: 'matches', write: false };
  }
}

module.exports = { classifyWeClosingDelta, routeWeAuditResult };
