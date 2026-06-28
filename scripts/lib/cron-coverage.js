'use strict';

/**
 * Pure helpers for the scheduled-workflow coverage gate in
 * audit-cron-health-coverage.js.
 *
 * Every scheduled (cron) workflow must be EITHER monitored in check-cron-health.yml's
 * CRITICAL_CRONS (real-time paging) OR listed in .cron-health-exempt.txt (digest-only /
 * low-stakes). A scheduled workflow in NEITHER has zero monitoring and can die silently —
 * the gap that hid process-feedback.yml being disabled for 15 days (2026-06-11..26).
 */

// Does a workflow YAML body declare a scheduled (cron) trigger?
function isScheduledWorkflow(yamlText) {
  if (!yamlText) return false;
  return /^\s*schedule:/m.test(yamlText) && /cron:\s*['"]/.test(yamlText);
}

// Parse a .cron-health-exempt.txt body into a Set of workflow filenames.
// One filename per line; `#` comments and blank lines ignored; trailing whitespace trimmed.
function parseExemptList(text) {
  const out = new Set();
  for (const raw of (text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    out.add(line);
  }
  return out;
}

/**
 * Scheduled workflows covered by neither CRITICAL_CRONS nor the exempt list.
 * @param {string[]} scheduled - filenames of workflows with a cron trigger
 * @param {Set<string>} covered - filenames present in CRITICAL_CRONS
 * @param {Set<string>} exempt  - filenames present in the exempt list
 * @returns {string[]} sorted uncovered filenames
 */
function findUncoveredScheduled(scheduled, covered, exempt) {
  return scheduled
    .filter(f => !covered.has(f) && !exempt.has(f))
    .sort();
}

/**
 * Exempt entries that are stale — listed but no longer a scheduled workflow (deleted
 * or de-scheduled), or also in CRITICAL_CRONS (double-listed). Keeps the allowlist honest.
 * @returns {{ notScheduled: string[], alsoCovered: string[] }}
 */
function findStaleExempt(exempt, scheduledSet, covered) {
  const notScheduled = [], alsoCovered = [];
  for (const f of exempt) {
    if (!scheduledSet.has(f)) notScheduled.push(f);
    else if (covered.has(f)) alsoCovered.push(f);
  }
  return { notScheduled: notScheduled.sort(), alsoCovered: alsoCovered.sort() };
}

module.exports = { isScheduledWorkflow, parseExemptList, findUncoveredScheduled, findStaleExempt };
