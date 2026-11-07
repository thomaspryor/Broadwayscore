'use strict';
// BRO-5308: scripts that push review-texts mid-run (collect-review-texts.js
// checkpoints, recover-wayback-reviews.js) can leave nothing for the final
// .github/actions/push-review-texts call, which then reports pushed='' even
// though this job did change review-texts. Workflows gate their rebuild
// dispatch on that output, so a mid-run push drops a marker in the job's
// RUNNER_TEMP and the action reports pushed=true when it sees it.
// RUNNER_TEMP is per-job and wiped between jobs, so the marker never leaks.
const fs = require('fs');
const path = require('path');

const MARKER_NAME = 'review-texts-pushed.marker';

function reviewTextsPushedMarkerPath(env = process.env) {
  return env.RUNNER_TEMP ? path.join(env.RUNNER_TEMP, MARKER_NAME) : null;
}

// Call after a review-texts push succeeded. No-op outside Actions.
// Returns the marker path written, or null.
function markReviewTextsPushed(env = process.env) {
  const p = reviewTextsPushedMarkerPath(env);
  if (!p) return null;
  try {
    fs.writeFileSync(p, `${new Date().toISOString()}\n`, { flag: 'a' });
    return p;
  } catch {
    return null; // fail-open: worst case the rebuild waits for the cron backstop
  }
}

module.exports = { MARKER_NAME, reviewTextsPushedMarkerPath, markReviewTextsPushed };
