#!/usr/bin/env node
/**
 * filter-active-gather-shows.js
 *
 * Given a comma-separated show-id list on argv, drops any show already
 * covered by an active (in_progress/queued/...) gather-reviews.yml run —
 * scripts/lib/gather-idempotency.js's existing dedup (used by
 * audit-opening-night-coverage.js), reused here so update-show-status.yml's
 * catchup-zero-review-shows job doesn't dispatch a second gather run for a
 * show whose first attempt is still in flight (ship-check finding, BRO-3389:
 * the job dispatched its whole selected batch unconditionally).
 *
 * Prints the filtered comma-separated list (possibly empty) to stdout.
 * Fails OPEN on any `gh`/parse error — an idempotency check that can't run
 * must not block a real catch-up dispatch, so the input list passes through
 * unfiltered on failure (same fail-open posture gather-idempotency.js's own
 * callers already use).
 *
 * Usage: node scripts/filter-active-gather-shows.js "show-a,show-b"
 */
'use strict';

const { execSync } = require('child_process');
const { showsNeedingGather } = require('./lib/gather-idempotency');
const { hasHelpFlag } = require('./lib/cli-help');

const USAGE = `filter-active-gather-shows.js — drop show ids already covered by an in-flight gather-reviews.yml run.

Usage:
  node scripts/filter-active-gather-shows.js "show-a,show-b"`;

function main() {
  if (hasHelpFlag(process.argv.slice(2))) {
    console.log(USAGE);
    return;
  }
  const wanted = (process.argv[2] || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!wanted.length) {
    console.log('');
    return;
  }
  let activeRuns = [];
  try {
    const out = execSync('gh run list --workflow=gather-reviews.yml --json status,displayTitle --limit 100', { encoding: 'utf8' });
    activeRuns = JSON.parse(out);
  } catch (e) {
    console.error(`::warning::filter-active-gather-shows: could not check active gather-reviews runs (${e.message.split('\n')[0]}) — passing the batch through unfiltered`);
    console.log(wanted.join(','));
    return;
  }
  console.log(showsNeedingGather(activeRuns, wanted).join(','));
}

main();
