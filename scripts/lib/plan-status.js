'use strict';

// What execute-approved-fix.js does with a plan, by its status. A status no
// writer produces (a session typed "approved", BRO-5015) used to read as
// already-applied and the run went green while moving nothing.
// Executor-written statuses. Superseded is a separate, reviewed withdrawal,
// not a claim that CI executed the plan (see finishedOnBranchProblems).
const DONE_STATUSES = new Set(['applied', 'partial', 'rejected', 'validation-failed']);

function planStatusAction(status) {
  if (status === 'pending') return 'run';
  if (status === 'superseded') return 'already-applied';
  if (DONE_STATUSES.has(status)) return 'already-applied';
  return 'error';
}

// BRO-5647: a session ran the executor locally to preview a plan, which wrote
// "applied" into the plan file; the file then landed and the CI apply skipped
// it as done while the run went green. The executor now tags every status it
// writes with where it ran, and a session plan (a non-numeric id) that comes
// back finished with the local tag is reported as applied-elsewhere, which the
// workflow fails. A missing tag stays already-applied: the ~600 plans CI
// finished before the tag existed have none. Numbered reader plans keep their
// "Already Applied" comment.
const planRunOrigin = (env = process.env) => (env.GITHUB_ACTIONS === 'true' ? 'ci' : 'local');

function alreadyAppliedResult(planId, plan) {
  if (!/^\d/.test(String(planId)) && plan && plan.executedIn === 'local') return 'applied-elsewhere';
  return 'already-applied';
}

module.exports = { planStatusAction, DONE_STATUSES, planRunOrigin, alreadyAppliedResult };
