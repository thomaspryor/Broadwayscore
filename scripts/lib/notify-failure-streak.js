'use strict';

const { runIsRed } = require('./auto-fix-first.js');

/**
 * Count the current notifying run plus prior failures, in completion order.
 * Reuse the auto-fix sweep's cancellation policy: a cancelled run counts when
 * its Notify step ran or was cut off, while a skipped Notify (Express takeover)
 * or a run cancelled in the queue neither extends nor resets the streak.
 * fetchJobs(id) returns every job for that run. Errors propagate to the action's
 * fail-open catch, rather than silently suppressing a real outage.
 */
async function failureStreak(runs, currentRunId, fetchJobs) {
  const prior = (runs || [])
    .filter((r) => r.id !== currentRunId)
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  let streak = 1; // The caller's failure/cancelled condition admitted this run.
  for (const run of prior) {
    if (run.conclusion === 'skipped') continue;
    if (run.conclusion === 'cancelled') {
      if (runIsRed(run, await fetchJobs(run.id))) streak++;
      continue;
    }
    if (run.conclusion !== 'failure') break;
    streak++;
  }
  return streak;
}

module.exports = { failureStreak };
