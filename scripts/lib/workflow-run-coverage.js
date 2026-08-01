#!/usr/bin/env node
/**
 * Pure detector for task #737's bug class: a workflow file registered on
 * GitHub Actions that has a LIFETIME run count of zero. Distinct from
 * `audit-workflow-activity.js`'s NEVER-RUN bucket, which flags on run
 * history alone and would false-positive on a workflow added an hour ago —
 * this adds an age floor (`minAgeDays`) so a brand-new workflow isn't
 * flagged before it's had a realistic chance to fire (manual dispatch,
 * first cron tick, etc).
 *
 * Callers own the GitHub API call — this function takes plain data so it's
 * unit-testable without network access (CLAUDE.md rule 15).
 */
'use strict';

/**
 * @param {object} opts
 * @param {Array<{file: string, createdAt: string|number|Date}>} opts.workflows
 *   Every workflow file to consider, with its GitHub Actions registration
 *   timestamp (the `created_at` field from `GET /repos/{o}/{r}/actions/workflows/{id}`).
 * @param {Record<string, number>} opts.runCountsByFile
 *   Lifetime run count per workflow filename (the `total_count` field from
 *   `GET .../actions/workflows/{id}/runs?per_page=1`). A file absent from
 *   this map is treated as zero runs.
 * @param {string|number|Date} opts.now
 *   Reference "current time" for age calculation.
 * @param {number} [opts.minAgeDays=30]
 *   A zero-run workflow younger than this is not flagged — it just hasn't
 *   had a realistic chance to fire yet.
 * @returns {string[]} filenames of workflows with zero lifetime runs that
 *   are older than minAgeDays. A workflow with a missing/unparseable
 *   createdAt is treated as infinitely old (flagged if it has zero runs) —
 *   missing registration data should never hide a real "never ran" case.
 */
function findNeverRunWorkflows({ workflows, runCountsByFile, now, minAgeDays = 30 }) {
  const nowMs = toMs(now);
  const offenders = [];

  for (const wf of workflows || []) {
    const runCount = runCountsByFile?.[wf.file] ?? 0;
    if (runCount > 0) continue;

    const createdMs = toMs(wf.createdAt);
    const ageDays = createdMs === null ? Infinity : (nowMs - createdMs) / (1000 * 60 * 60 * 24);
    if (ageDays > minAgeDays) offenders.push(wf.file);
  }

  return offenders;
}

function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const ms = new Date(value).getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

module.exports = { findNeverRunWorkflows };
