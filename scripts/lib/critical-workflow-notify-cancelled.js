'use strict';

const fs = require('fs');
const path = require('path');

/**
 * BRO-3707: a job-level `timeout-minutes` firing mid-run reports the job's
 * conclusion (and every in-progress/pending step's outcome) as `cancelled`,
 * not `failure` — so a Notify-on-failure step gated on a bare `if: failure()`
 * silently never fires for a timeout, exactly the alert this repo relies on
 * for a severity:'critical' pipeline. `cancelled()` has to appear in the
 * condition for the alert to survive that path. (BRO-2531 / BRO-162 are the
 * same class on non-critical workflows; opening-digest.yml and
 * tests/unit/... test.yml's "Awards Data Stale" step are the reference
 * `if: failure() || cancelled()` shape this scan checks for.)
 *
 * Self-registering by design: this walks every job in every workflow file
 * looking for `uses: ./.github/actions/notify-failure` steps whose
 * `with.severity` is the literal string 'critical' — a NEW critical workflow
 * is picked up automatically, no test file to remember to add.
 */

const NOTIFY_ACTION = './.github/actions/notify-failure';

function listWorkflowFiles(workflowsDir) {
  return fs
    .readdirSync(workflowsDir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort();
}

/**
 * Every `uses: ./.github/actions/notify-failure` step with a literal
 * `severity: 'critical'`, across every job in every workflow file.
 */
function findCriticalNotifySteps(workflowsDir, yamlLoad) {
  const found = [];
  for (const file of listWorkflowFiles(workflowsDir)) {
    const doc = yamlLoad(fs.readFileSync(path.join(workflowsDir, file), 'utf-8')) || {};
    for (const [jobId, job] of Object.entries(doc.jobs || {})) {
      const steps = job.steps || [];
      steps.forEach((step, index) => {
        if (step.uses !== NOTIFY_ACTION) return;
        if (step.with?.severity !== 'critical') return;
        found.push({
          file,
          jobId,
          index,
          steps,
          name: step.name || '(unnamed)',
          if: String(step.if || ''),
        });
      });
    }
  }
  return found;
}

/**
 * The condition itself must be reachable when the job is cancelled. A bare
 * substring test on `cancelled()` would also match `!cancelled()`, which
 * means the opposite of coverage — reject a negated occurrence explicitly
 * rather than count it (BRO-3707 adversarial review finding).
 */
function coversCancellation(ifCondition) {
  if (/!\s*cancelled\(\)/.test(ifCondition)) return false;
  return /\bcancelled\(\)/.test(ifCondition);
}

/**
 * Even with `cancelled()` on the notify step itself, a LOCAL composite
 * action (`uses: ./...`) can only resolve if the workspace was checked out.
 * If every checkout step ahead of it in the job is conditional (no
 * unconditional checkout exists), those conditional checkouts must ALSO
 * cover cancellation, or the notify step still silently can't run —
 * r2-cold-backup.yml's "Checkout for notify action" is the case this covers
 * (that job has no leading unconditional checkout at all).
 */
function checkoutBlocksCancelledNotify(entry) {
  const priorSteps = entry.steps.slice(0, entry.index);
  // Only recognizes the raw actions/checkout@* step, not composite wrappers
  // like ./.github/actions/checkout-core-data (none of which check out the
  // repo root today). A future critical workflow that checks out ONLY via a
  // composite action would hit checkouts.length === 0 below and be silently
  // treated as out of scope.
  const checkouts = priorSteps.filter(
    (s) => typeof s.uses === 'string' && s.uses.startsWith('actions/checkout')
  );
  const hasUnconditionalCheckout = checkouts.some((s) => !s.if);
  if (hasUnconditionalCheckout) return false;
  if (checkouts.length === 0) return false; // out of scope for this check
  return checkouts.every((s) => !coversCancellation(String(s.if || '')));
}

module.exports = {
  NOTIFY_ACTION,
  findCriticalNotifySteps,
  coversCancellation,
  checkoutBlocksCancelledNotify,
};
