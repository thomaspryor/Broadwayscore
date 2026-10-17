'use strict';

// What execute-approved-fix.js does with a plan, by its status. A status no
// writer produces (a session typed "approved", BRO-5015) used to read as
// already-applied and the run went green while moving nothing.
const DONE_STATUSES = new Set(['applied', 'partial', 'rejected', 'validation-failed']);

function planStatusAction(status) {
  if (status === 'pending') return 'run';
  if (DONE_STATUSES.has(status)) return 'already-applied';
  return 'error';
}

module.exports = { planStatusAction, DONE_STATUSES };
