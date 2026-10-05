/**
 * Health decision for data/audit/card-verifiability-linear.json (BRO-2997).
 *
 * Why: BRO-2718 swept the Linear backlog from 29% refused to 0.4%, but nothing
 * regenerated the report afterward, so it sat 20 days stale and new no-section
 * issues would have gone stuck unnoticed. card-verifiability-audit.yml now
 * refreshes it daily; this function is the alarm for that refresh stopping,
 * and for the specific regressions BRO-2718 removed.
 *
 * Deliberately does NOT warn on "any refused > 0": a handful of refusals is the
 * steady state (cards mid-triage), and a row that never clears gets ignored.
 */

'use strict';

const STALE_WARN_HOURS = 48; // one missed daily run plus GHA cron slip (feedback_github_cron_delays)
const STALE_ERROR_HOURS = 96;
// Mirrors REFUSED_RATIO_CEILING in scripts/tests/linear-backlog-verifiability.test.mjs.
const REFUSED_RATIO_CEILING = 0.5;
const REGRESSION_KINDS = ['shape', 'basename']; // a real command rejected by the safe-form check

/**
 * @param {object|null|undefined} report parsed card-verifiability-linear.json (null = file missing/unreadable)
 * @param {number} nowMs
 * @returns {{severity:'warn'|'error', reason:string}|null} null when healthy
 */
function checkCardVerifiabilityLinear(report, nowMs) {
  if (!report || typeof report !== 'object') {
    return { severity: 'warn', reason: 'report missing or unreadable' };
  }
  const generatedMs = Date.parse(report.generatedAt);
  if (!Number.isFinite(generatedMs)) {
    return { severity: 'warn', reason: 'report has no valid generatedAt' };
  }
  const hours = (nowMs - generatedMs) / 3600000;
  if (hours >= STALE_WARN_HOURS) {
    return {
      severity: hours >= STALE_ERROR_HOURS ? 'error' : 'warn',
      reason: `report is ${hours.toFixed(1)}h old (card-verifiability-audit.yml refreshes it daily)`,
    };
  }
  const refused = Array.isArray(report.refused) ? report.refused : [];
  const regress = refused.filter((c) => REGRESSION_KINDS.includes(c.kind));
  if (regress.length > 0) {
    return {
      severity: 'warn',
      reason: `${regress.length} issue(s) refused as shape/basename (a real command rejected by safe-form), e.g. ${regress.slice(0, 3).map((c) => c.id).join(', ')}`,
    };
  }
  const total = Number(report.total) || 0;
  if (total > 0 && refused.length / total >= REFUSED_RATIO_CEILING) {
    return { severity: 'warn', reason: `${refused.length}/${total} open issues refused (>= ${REFUSED_RATIO_CEILING * 100}%)` };
  }
  return null;
}

module.exports = { checkCardVerifiabilityLinear, STALE_WARN_HOURS, STALE_ERROR_HOURS, REFUSED_RATIO_CEILING };
