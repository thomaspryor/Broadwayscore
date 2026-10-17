/**
 * Staleness row for data/audit/open-backlog-acceptance-sweep.json (BRO-4382).
 *
 * Why: scripts/sweep-open-backlog-acceptance.js (writeReport) runs daily from
 * data-health-check.yml's "Open backlog acceptance sweep (shadow mode)" step,
 * which is continue-on-error, as is its commit step. If either silently stops
 * landing, linear-watchdog-source.js's `alreadyPasses` gate keeps reading the
 * last committed report as if it were current. Nothing else watched its
 * `generatedAt`, so this pure function turns it into a digest row.
 *
 * Conventions (match neighbouring health-check.js rows):
 *   - report missing  -> warn "not yet run" (same as notionScheduleCouplingResults;
 *     data/ files in cloud sessions are disposable copies and may be absent)
 *   - unparseable JSON / missing or unparseable generatedAt -> error
 *     (a sweep that cannot prove it ran is treated like one that did not,
 *     same as checkFreshness / evaluateAuditFreshness)
 *   - age > 96h -> error, age > 48h -> warn (daily cron; the health check runs before the sweep step in the
 *     same job, so it reads the previous day's report: warn fires after ~2 missed runs)
 *
 * Ages come from scripts/lib/hours-ago.js, the helper every freshness row uses.
 * Tested by scripts/tests/health-check-sweep-staleness.test.mjs (require()s
 * this module, CLAUDE.md §15).
 */

'use strict';

const { hoursAgo, formatAge } = require('./hours-ago');

const SWEEP_REPORT_ROW_NAME = 'Freshness: audit/open-backlog-acceptance-sweep.json';
// AUTO_FIX_PLAYBOOK key in health-check.js (exact-name match).
const SWEEP_REPORT_ROW_MATCH = /^Freshness: audit\/open-backlog-acceptance-sweep\.json$/;
const SWEEP_REPORT_WARN_H = 48;
const SWEEP_REPORT_ERROR_H = 96;
const SWEEP_REPORT_HINT = 'Check the "Open backlog acceptance sweep (shadow mode)" and "Commit open backlog acceptance sweep" steps in data-health-check.yml (both continue-on-error, so a failure there does not turn the run red); node scripts/sweep-open-backlog-acceptance.js --dry-run confirms it can still plan a sweep.';

/**
 * @param {{report?: object|null, parseError?: string|null}} input
 *   report: parsed JSON, or null/undefined when the file is absent.
 *   parseError: set when the file exists but is not valid JSON.
 * @param {number} [nowMs]
 * @returns {{name: string, status: 'pass'|'warn'|'error', message: string, hint?: string}}
 */
function sweepReportStalenessResult({ report = null, parseError = null } = {}, nowMs = Date.now()) {
  const name = SWEEP_REPORT_ROW_NAME;
  const hint = SWEEP_REPORT_HINT;
  if (parseError) {
    return { name, status: 'error', message: `Unparseable JSON: ${String(parseError).split('\n')[0].slice(0, 80)}`, hint };
  }
  if (report === null || report === undefined) {
    return { name, status: 'warn', message: 'No open-backlog acceptance sweep report yet (sweep not yet run)', hint };
  }
  const value = report && typeof report === 'object' ? report.generatedAt : undefined;
  if (!value) {
    return { name, status: 'error', message: 'No generatedAt field', hint };
  }
  const age = hoursAgo(value, nowMs);
  if (age === Infinity) {
    return { name, status: 'error', message: `Unparseable date: ${value}`, hint };
  }
  if (age > SWEEP_REPORT_ERROR_H) {
    return { name, status: 'error', message: `${formatAge(age)} old (error threshold: ${formatAge(SWEEP_REPORT_ERROR_H)})`, hint };
  }
  if (age > SWEEP_REPORT_WARN_H) {
    return { name, status: 'warn', message: `${formatAge(age)} old (warn threshold: ${formatAge(SWEEP_REPORT_WARN_H)})`, hint };
  }
  if (report.fetchError) {
    return { name, status: 'warn', message: `Latest sweep wrote a failure report (fetchError: ${String(report.fetchError).slice(0, 80)}); the watchdog reads an empty result set`, hint };
  }
  return { name, status: 'pass', message: `${formatAge(age)} old` };
}

module.exports = {
  sweepReportStalenessResult,
  SWEEP_REPORT_ROW_NAME,
  SWEEP_REPORT_ROW_MATCH,
  SWEEP_REPORT_WARN_H,
  SWEEP_REPORT_ERROR_H,
};
