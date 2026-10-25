/**
 * Table-driven freshness checks for data/audit/*.json detector outputs (BRO-2476).
 *
 * Why: scripts/health-check.js's FRESHNESS_CHECKS only covers top-level
 * data/*.json. The cron detectors that write data/audit/*.json had no staleness
 * check at all, so a detector whose workflow stopped running (disabled, kill
 * switch left on, commit step silently skipped, schedule dropped) kept serving
 * its last committed report forever, and every digest row that reads that
 * report kept reporting the frozen snapshot as current. None of the writer
 * workflows below is in CRITICAL_CRONS (scripts/lib/health-digest-crons.js),
 * so nothing else watches them either. BRO-114's bespoke
 * reverse-discovery-freshness.js covers one such file; this is the generic
 * version for the rest.
 *
 * Row selection rule (each row's comment carries the evidence):
 *   (a) written by a SCHEDULED workflow that git-adds + commits the file, so
 *       the committed copy refreshes on every run;
 *   (b) the writer stamps `field` with new Date().toISOString() on every run
 *       (so the commit always has a diff and never no-ops);
 *   (c) fresh on 2026-10-13 relative to its cadence (no row ships red).
 * Thresholds come from MEASURED commit spacing of each file (GitHub commits
 * API, path=data/audit/<file>, 2026-10-13), not the nominal cron: GitHub's
 * schedule lag routinely stretches sub-daily crons to 3-14h between landings
 * (BRO-4801). Goal: no flapping on normal lag, but ONE missed weekly run warns
 * (a normal weekly landing is <=174h apart; a skipped week is ~336h).
 *
 * A kill-switch var that deliberately disables a detector WILL turn its row
 * red. That is intended: a disabled detector's committed report is stale and
 * its consumers should know.
 *
 * evaluateAuditFreshness() is pure (row + parsed JSON + now). File reading,
 * JSON parsing and row formatting live in health-check.js's
 * checkAuditFreshness(), mirroring checkFreshness(). Tested by
 * tests/unit/audit-freshness-checks.test.mjs (CLAUDE.md §15: the test
 * require()s this module, it does not restate it).
 */

'use strict';

// Measured max gaps (commit spacing, see each row): hourly 9.8h, every-4h
// 14.1h, weekly <=174h when no run is skipped.
const HOURLY = { warnH: 18, errorH: 48 };
const EVERY_4H = { warnH: 24, errorH: 60 };
const DAILY = { warnH: 48, errorH: 96 };
const DAILY_LAGGY = { warnH: 72, errorH: 120 };
const WEEKLY = { warnH: 200, errorH: 400 };

// `workflow` + `urgency` + `humanFallback` feed health-check.js's
// AUTO_FIX_PLAYBOOK (one entry per row, generated from this table, so a stale
// row is named in the digest body and its writer is dispatched instead of
// falling into "+N low-priority"). `hint` names the job/step kill switches
// that would also freeze the file.
// audit-aggregator-gap.yml treats a bare workflow_dispatch as a manual run:
// 21-day window and NO 6h throttle on the paid outlet ground-truth audit.
// redispatched=true makes the auto-fix run behave like the cron (the same
// input scripts/cron-redispatch.js passes). BRO-5261 retro-review.
const CRON_LIKE_REDISPATCH = { dispatchInputs: { redispatched: 'true' } };

const AUDIT_FRESHNESS_CHECKS = [
  // Writer: scripts/audit-t1-silent-gaps.js (step "T1/T2 silent-gap sweep").
  // Workflow: audit-aggregator-gap.yml, cron '37 * * * *' (hourly); committed by
  // its "Commit audit JSON (public repo)" per-file add loop.
  // Measured: 100 commits 2026-09-27..10-13, median 3.8h, p90 7.1h, max 9.8h.
  { file: 't1-silent-gaps.json', field: 'generatedAt', ...HOURLY,
    workflow: 'audit-aggregator-gap.yml', urgency: 'this-week', ...CRON_LIKE_REDISPATCH,
    humanFallback: 'The hourly coverage-gap check (missing top-critic reviews) has stopped updating its report.',
    hint: 'Check audit-aggregator-gap.yml (hourly) "T1/T2 silent-gap sweep" step; kill switches: repo vars AGGREGATOR_GAP_AUDIT_DISABLED (whole job), T1_SILENT_GAP_DISABLED (step)' },
  // Writer: scripts/audit-uncollected-live-reviews.js (step "Uncollected-review
  // strand guard"). Workflow: audit-aggregator-gap.yml, hourly; same commit loop.
  // Measured: identical to t1-silent-gaps (same commit), max 9.8h.
  { file: 'uncollected-live-reviews.json', field: 'generatedAt', ...HOURLY,
    workflow: 'audit-aggregator-gap.yml', urgency: 'this-week', ...CRON_LIKE_REDISPATCH,
    humanFallback: 'The hourly check for found-but-never-collected reviews has stopped updating its report.',
    hint: 'Check audit-aggregator-gap.yml (hourly) "Uncollected-review strand guard" step; kill switches: repo vars AGGREGATOR_GAP_AUDIT_DISABLED (whole job), UNCOLLECTED_STRAND_AUDIT_DISABLED (step)' },
  // Writer: scripts/audit-imageless-scored-shows.js. Workflow:
  // audit-imageless-scored-shows.yml, cron '0 */4 * * *' (every 4h); explicit
  // `git add data/audit/imageless-scored-shows.json` + commit step.
  // Measured: 100 commits 2026-09-19..10-13, median 6.3h, p90 7.9h, max 14.1h.
  { file: 'imageless-scored-shows.json', field: 'generatedAt', ...EVERY_4H,
    workflow: 'audit-imageless-scored-shows.yml', urgency: 'this-week',
    humanFallback: 'The check for scored shows missing a poster image has stopped updating its report.',
    hint: 'Check audit-imageless-scored-shows.yml (every 4h) in Actions tab (no kill-switch var; commit step skips on dry_run dispatches)' },
  // Writer: scripts/validate-show-venue.js. Workflow: audit-provisional-venues.yml,
  // cron '25 20 * * *' (daily); `git add data/audit/venue-date-mismatches.json`
  // commit step (gated on scrape secrets being present). Skips whole days and
  // lands 5-12h late. Measured since 2026-09-07: gaps 35.1h, 59.8h, 47.7h,
  // 35.8h, 38.7h (max 59.8h). Note 33 of its last 34 scheduled runs concluded
  // `failure` while still committing this file (failure is after the commit).
  { file: 'venue-date-mismatches.json', field: 'generatedAt', ...DAILY_LAGGY,
    workflow: 'audit-provisional-venues.yml', urgency: 'this-week',
    humanFallback: 'The daily venue/date cross-check against Playbill has stopped updating its report.',
    hint: 'Check audit-provisional-venues.yml (daily 20:25 UTC) in Actions tab; kill switch: repo var PROVISIONAL_VENUE_AUDIT_DISABLED (whole job); its commit step skips if SCRAPINGBEE_API_KEY/BRIGHTDATA_TOKEN are missing' },
  // Writer: scripts/audit-alert-senders.js (via monitor-scheduled-email-count.js).
  // Workflow: monitor-scheduled-email-count.yml, cron '0 15 * * *' (daily);
  // "Commit alert ledger" step (if: always()) adds it on every non-dry-run.
  // Measured: every gap since 2026-09-13 <=30h (median 24.0h). Earlier history
  // had 52.8h-566h gaps (Jul-Sep) that this row would have flagged.
  { file: 'alert-sender-inventory.json', field: 'generatedAt', ...DAILY,
    workflow: 'monitor-scheduled-email-count.yml', urgency: 'this-week',
    humanFallback: 'The daily inventory of scripts that send alert emails has stopped updating.',
    hint: 'Check monitor-scheduled-email-count.yml (daily 15:00 UTC) in Actions tab (no kill-switch var; skips the file on dry_run dispatches)' },
  // Writer: scripts/detect-ob-closings.js. Workflow: detect-ob-closings.yml,
  // cron '0 12 * * 1' (weekly, Mondays); commit step adds the file.
  // Measured: normal spacing 167-174h; skipped weeks seen (334.8h to
  // 2026-09-14, 337.6h to 2026-10-12) — each would warn at 200h.
  { file: 'ob-closing-candidates.json', field: 'generatedAt', ...WEEKLY,
    workflow: 'detect-ob-closings.yml', urgency: 'this-week',
    humanFallback: 'The weekly Off-Broadway closing-date detector has stopped updating its report.',
    hint: 'Check detect-ob-closings.yml (weekly, Mondays 12:00 UTC) in Actions tab (no kill-switch var)' },
  // Writer: scripts/audit-cross-production.js. Workflow:
  // audit-cross-production-weekly.yml, cron '0 14 * * 0' (weekly, Sundays);
  // "Commit and push" step adds the file.
  // Measured: normal spacing 167.7-168.7h; misses seen: 336.1h (x2) and
  // 674.9h to 2026-09-20 (would have errored at 400h).
  { file: 'same-title-confusion.json', field: 'generatedAt', ...WEEKLY,
    workflow: 'audit-cross-production-weekly.yml', urgency: 'this-week',
    humanFallback: 'The weekly check for reviews filed under the wrong production of a same-titled show has stopped updating.',
    hint: 'Check audit-cross-production-weekly.yml (weekly, Sundays 14:00 UTC) in Actions tab (no kill-switch var)' },
  // Writer: scripts/audit-slug-match-routing.js. Workflow:
  // audit-cross-production-weekly.yml (weekly, Sundays); same commit step.
  // Measured: normal 167.7-168.7h; misses seen: 336.1h (x2), 564.6h to 2026-09-16.
  { file: 'slug-misroute-audit.json', field: 'generatedAt', ...WEEKLY,
    workflow: 'audit-cross-production-weekly.yml', urgency: 'this-week',
    humanFallback: 'The weekly check for reviews routed to the wrong show page has stopped updating.',
    hint: 'Check audit-cross-production-weekly.yml (weekly, Sundays 14:00 UTC) slug-misroute step in Actions tab (no kill-switch var)' },
  // Writer: scripts/sweep-open-backlog-acceptance.js (writeReport), one
  // continue-on-error step of data-health-check.yml (BRO-4382), so a stopped
  // sweep never turns that run red and linear-watchdog-source.js keeps reading
  // the last committed report. Daily cron; the health check runs before the
  // sweep step in the same job, so it reads the previous day's report.
  // missingStatus 'warn': data/ files in cloud sessions are disposable copies
  // and may be absent. fetchErrorWarn: a fresh report carrying fetchError means
  // the watchdog reads an empty result set. No `workflow`: redispatching the
  // whole health job to refresh one shadow report is not worth it, so the
  // playbook entry asks a human (humanAction).
  { file: 'open-backlog-acceptance-sweep.json', field: 'generatedAt', ...DAILY,
    missingStatus: 'warn', missingMessage: 'No open-backlog acceptance sweep report yet (sweep not yet run)', fetchErrorWarn: true,
    workflow: null, urgency: 'this-week',
    humanAction: 'The daily sweep that checks which open backlog cards already pass their acceptance check has stopped updating its report, so the watchdog is reading an old snapshot. Nothing is needed from you; the sweep and commit steps in data-health-check.yml (BRO-4382) are what need a look, and the next board worker will pick that up.',
    hint: 'Check the "Open backlog acceptance sweep (shadow mode)" and "Commit open backlog acceptance sweep" steps in data-health-check.yml (both continue-on-error, so a failure there does not turn the run red); node scripts/sweep-open-backlog-acceptance.js --dry-run confirms it can still plan a sweep.' },
  // BRO-3944: check-progress-stalls.js writes lastRunAt on the daily 04:30
  // scoring cron, even when the rescore queue is empty. Its own pre-write
  // guard catches lost history; this independent reader catches a stopped
  // writer. Real history includes 96-119h gaps. Allow three days of scoring
  // lag, then warn. Do not auto-dispatch the paid scoring workflow to repair
  // telemetry. The existing health digest routes this row for investigation.
  { file: 'progress-watch-state.json', field: 'lastRunAt', warnH: 72, errorH: 120, preWriteAlertField: 'priorLedgerAlert',
    workflow: null, urgency: 'this-week',
    humanAction: 'The rescore progress monitor has stopped persisting observations. Investigate the daily Snapshot progress-watch state step and commit in llm-ensemble-score.yml; no owner action is needed.',
    hint: 'Check llm-ensemble-score.yml daily 04:30 cron, Snapshot progress-watch state step, and persistence of data/audit/progress-watch-state.json.' },
];

/** Exact digest row name for a table row (also the AUTO_FIX_PLAYBOOK key). */
function auditFreshnessRowName(row) {
  return `Freshness: audit/${row.file}`;
}

/** AUTO_FIX_PLAYBOOK entries, same shape as the hand-written Freshness ones. */
function auditFreshnessPlaybookEntries() {
  return AUDIT_FRESHNESS_CHECKS.map((row) => ({
    match: new RegExp(`^${auditFreshnessRowName(row).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`),
    urgency: row.urgency,
    ...(row.workflow ? { workflow: row.workflow, humanFallback: row.humanFallback } : { humanAction: row.humanAction }),
    ...(row.dispatchInputs ? { dispatchInputs: row.dispatchInputs } : {}),
  }));
}

// Ages come from the SAME helper health-check.js uses (scripts/lib/hours-ago.js):
// BRO-3349 bare-day rule, clamped at 0.
const { hoursAgo: ageHours, formatAge } = require('./hours-ago');

/**
 * @param {{file: string, field: string, warnH: number, errorH: number}} row
 * @param {object|null|undefined} data - parsed JSON; null/undefined = file missing
 * @param {number} nowMs
 * @returns {{status: 'ok'|'warn'|'error', ageH: number|null, message: string}}
 */
/** Dotted-path lookup ("_meta.lastUpdated") used by the evaluator and its test. */
function auditFieldValue(data, field) {
  return field.split('.').reduce((obj, key) => (obj && typeof obj === 'object' ? obj[key] : undefined), data);
}

function evaluateAuditFreshness(row, data, nowMs) {
  // Conventions match health-check.js checkFreshness(): missing file, missing
  // field and unparseable date are all errors (a detector that cannot prove it
  // ran is treated like one that did not).
  if (data === null || data === undefined) {
    return { status: row.missingStatus || 'error', ageH: null, message: row.missingMessage || 'File missing' };
  }
  const value = auditFieldValue(data, row.field);
  if (!value) {
    return { status: 'error', ageH: null, message: `No ${row.field} field` };
  }
  const age = ageHours(value, nowMs);
  if (age === Infinity) {
    return { status: 'error', ageH: null, message: `Unparseable date: ${value}` };
  }
  if (age > row.errorH) {
    return { status: 'error', ageH: age, message: `${formatAge(age)} old (error threshold: ${formatAge(row.errorH)})` };
  }
  if (age > row.warnH) {
    return { status: 'warn', ageH: age, message: `${formatAge(age)} old (warn threshold: ${formatAge(row.warnH)})` };
  }
  // BRO-3944: a fresh write carries the writer's PRE-write history finding.
  // Route here because the daily health job has Linear credentials, while
  // the scoring snapshot step does not. Never mistake its fresh date for
  // proof that previous observations persisted.
  const priorAlert = row.preWriteAlertField && auditFieldValue(data, row.preWriteAlertField);
  if (priorAlert) {
    return { status: 'warn', ageH: age, message: priorAlert.description || 'Latest run found stale or discontinuous persisted history' };
  }
  if (row.fetchErrorWarn && data.fetchError) {
    return { status: 'warn', ageH: age, message: `Latest run wrote a failure report (fetchError: ${String(data.fetchError).slice(0, 80)}); consumers read an empty result set` };
  }
  return { status: 'ok', ageH: age, message: `${formatAge(age)} old` };
}

module.exports = { AUDIT_FRESHNESS_CHECKS, evaluateAuditFreshness, auditFieldValue, ageHours, auditFreshnessRowName, auditFreshnessPlaybookEntries };
