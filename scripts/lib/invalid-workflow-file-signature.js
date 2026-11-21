/**
 * Invalid-workflow-file signature (BRO-7307).
 *
 * When a workflow file is invalid GitHub cannot start it, and records an
 * instant failed run on every push: event=push, run name equal to the file
 * path (".github/workflows/<file>.yml"), conclusion=failure, created_at ==
 * updated_at. No job runs, so notify-failure never fires. opening-night-
 * orchestrator.yml sat like this 2026-11-10 09:41..18:00 UTC (runs 1800-1998).
 *
 * Pure functions over REST `workflow_runs[]` objects.
 */
'use strict';

const WORKFLOW_PATH_RE = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const MAX_DURATION_MS = 1000;

function ms(t) {
  const v = Date.parse(t);
  return Number.isFinite(v) ? v : NaN;
}

/** True when one run has the invalid-file signature. */
function isInvalidWorkflowFileRun(run) {
  if (!run || run.event !== 'push' || run.conclusion !== 'failure') return false;
  if (typeof run.name !== 'string' || !WORKFLOW_PATH_RE.test(run.name)) return false;
  const created = ms(run.created_at);
  const updated = ms(run.updated_at);
  if (Number.isNaN(created) || Number.isNaN(updated)) return false;
  return updated - created <= MAX_DURATION_MS;
}

/**
 * Group signature runs by workflow file. A file is "currently invalid" when
 * its newest signature run is newer than every non-signature run of that same
 * file (a later normal run proves the file parses again). Non-signature runs
 * are matched by `path`, since their `name` is a display name.
 *
 * @param {{branch?: string|null}} [opts] default 'main'; null = every branch
 * @returns {Array<{file, count, newestAt, oldestAt, newestUrl}>} newest first
 */
function findInvalidWorkflowFiles(runs, { branch = 'main' } = {}) {
  const bad = new Map();
  const lastGood = new Map();
  for (const run of Array.isArray(runs) ? runs : []) {
    // Only the default branch counts: a broken file on an unmerged branch must
    // not page, and a good run on another branch must not hide a broken main.
    if (!run || (branch && run.head_branch !== branch)) continue;
    if (isInvalidWorkflowFileRun(run)) {
      const file = run.name.split('/').pop();
      const t = ms(run.created_at);
      const e = bad.get(file) || { file, count: 0, newestAt: t, oldestAt: t, newestUrl: run.html_url || '' };
      e.count++;
      if (t >= e.newestAt) { e.newestAt = t; e.newestUrl = run.html_url || e.newestUrl; }
      if (t < e.oldestAt) e.oldestAt = t;
      bad.set(file, e);
    } else if (typeof run.path === 'string') {
      // any run that is not the signature actually started, so the file parsed
      const file = String(run.path).split('@')[0].split('/').pop();
      const t = ms(run.created_at);
      if (!Number.isNaN(t) && t > (lastGood.get(file) || 0)) lastGood.set(file, t);
    }
  }
  return [...bad.values()]
    .filter((e) => !(lastGood.get(e.file) > e.newestAt))
    .map((e) => ({ ...e, newestAt: new Date(e.newestAt).toISOString(), oldestAt: new Date(e.oldestAt).toISOString() }))
    .sort((a, b) => (a.newestAt < b.newestAt ? 1 : -1));
}

module.exports = { isInvalidWorkflowFileRun, findInvalidWorkflowFiles, WORKFLOW_PATH_RE };
