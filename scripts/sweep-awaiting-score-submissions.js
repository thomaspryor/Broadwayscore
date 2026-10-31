#!/usr/bin/env node
/**
 * sweep-awaiting-score-submissions.js [--dry-run]
 *
 * BRO-4141. process-review-submission.yml labels a submission `awaiting-score`
 * when its review was ingested but not yet scored, instead of emailing the
 * owner "not on the site" (all 11 such emails on 9/23-9/24 went live on their
 * own ~45 min later). This sweep, run by rebuild-fast.yml after each rebuild:
 *   - closes the issue once the review is in reviews.json
 *   - after AWAITING_SCORE_MAX_HOURS, relabels it `needs-manual-review`, which
 *     health-check.js already surfaces in the morning digest (no email)
 *   - also closes needs-manual-review submissions that subsequently landed
 *     (BRO-4103); unresolved submissions and other feedback stay open
 *
 * Uses the gh CLI with GH_TOKEN. rebuild-fast passes GH_DISPATCH_TOKEN, the
 * owner PAT that opened the issues, so the owner isn't emailed about closes.
 */

const { sweepSubmissions } = require('./lib/submission-sweep');
const { AWAITING_SCORE_MAX_HOURS } = require('./lib/submission-landing');
const { hasHelpFlag } = require('./lib/cli-help');

const USAGE = `Usage: node scripts/sweep-awaiting-score-submissions.js [--dry-run]
  Closes awaiting-score or needs-manual-review submissions whose review is live;
  relabels ones stuck past ${AWAITING_SCORE_MAX_HOURS}h as needs-manual-review.
  --dry-run   print the decision per issue, change nothing`;

function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  sweepSubmissions({ dryRun: process.argv.includes('--dry-run') });
}

if (require.main === module) main();
