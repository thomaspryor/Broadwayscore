'use strict';

/**
 * BRO-7210 (BRO-4208 director veto follow-up): the weekly director-consensus audit
 * was advisory with no owner, so STRICT/ZERO findings sat unactioned for 30 days.
 * This turns them into one worker card via audit-alert.js (clears when clean).
 * Pure. Rows carry show ids, director names already on shows.json and counts only.
 */
const DIRECTOR_CONSENSUS_ALERT_KEY = 'director-consensus:strict';

/**
 * @param {Array<object>} findings the audit's findings
 * @param {number} scannedShows  0 means no input was read: no decision at all
 *   (resolving then would close a real card during an outage)
 * @returns {object|null} audit-alert decision, or null when nothing was scanned
 */
function decideDirectorConsensusAlert(findings, scannedShows) {
  if (!(scannedShows > 0)) return null;
  const actionable = (Array.isArray(findings) ? findings : []).filter((f) => f && (f.severity === 'STRICT' || f.severity === 'ZERO'));
  return require('./audit-alert').buildAuditAlert({
    conditionKey: DIRECTOR_CONSENSUS_ALERT_KEY,
    rows: actionable.map((f) => `${f.showId}: recorded ${JSON.stringify(f.recorded)} in ${f.recordedMentions}/${f.totalReviews} reviews, proposed ${JSON.stringify(f.proposedDirector)} (${f.proposedDirectorMentions}) [${f.severity}]`),
    title: (n) => `Director consensus: ${n} show${n === 1 ? '' : 's'} where reviews name a different director than shows.json`,
    intro: `The weekly director-consensus audit found ${actionable.length} show${actionable.length === 1 ? '' : 's'} whose recorded director is absent from the reviews while another director is named repeatedly. The named-entity bypass in review-guards.js depends on shows.json director accuracy.`,
    hint: 'For each show open 2 reviews and confirm who directed it, then fix the director in shows.json (core data repo, dry-run then apply) or, if the recorded one is right, note why. Done when node scripts/audit-show-director-consensus.js --min-reviews=8 reports strictCount 0 and zeroCount 0.',
    resolveReason: 'no STRICT or ZERO director-consensus findings',
  });
}

module.exports = { decideDirectorConsensusAlert, DIRECTOR_CONSENSUS_ALERT_KEY };
