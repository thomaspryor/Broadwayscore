#!/usr/bin/env node
/**
 * find-zero-review-catchup-gaps.js
 *
 * CLI wrapper around scripts/lib/zero-review-catchup.js for
 * update-show-status.yml's catchup-zero-review-shows job (BRO-3389).
 *
 * Selection only — does NOT record an attempt. Writes gap_shows directly to
 * $GITHUB_OUTPUT (never via "the last stdout line": bash command
 * substitution strips ALL trailing blank lines, so when the batch is empty
 * `tail -1` picked up the preceding diagnostic sentence instead of an empty
 * string and would have dispatched it as a show id — ship-check finding).
 * The workflow records an attempt in a separate step, only after the
 * dispatch step actually succeeds (see record-zero-review-catchup-attempt.js)
 * — recording it here unconditionally would burn the give-up budget on
 * transient gh-cli/API failures that never really attempted collection.
 *
 * Guard (BRO-4290): rows the selector can never dispatch (no openingDate,
 * previewsStartDate or closingDate), open rows left out past grace + 14 days, and closed
 * rows the capped queue will not reach before the 90-day bound are printed as ::warning:: lines; --fail-on-stranded also
 * exits 1 after writing gap_shows, so the workflow's advisory guard step can
 * go red without blocking the dispatch.
 *
 * Usage: node scripts/find-zero-review-catchup-gaps.js [--fail-on-stranded]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { selectCatchupCandidates } = require('./lib/zero-review-catchup');
const { loadAttempts } = require('./lib/zero-review-catchup-attempts');

const ROOT = path.join(__dirname, '..');
const SHOWS_PATH = path.join(ROOT, 'data', 'shows.json');
const REVIEWS_PATH = path.join(ROOT, 'data', 'reviews.json');
const ATTEMPTS_PATH = path.join(ROOT, 'data', 'audit', 'zero-review-catchup-attempts.json');

function loadJsonArray(filePath, key) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return Array.isArray(data) ? data : (data[key] || []);
}

function main() {
  const shows = loadJsonArray(SHOWS_PATH, 'shows');
  const reviews = loadJsonArray(REVIEWS_PATH, 'reviews');
  const attempts = loadAttempts(ATTEMPTS_PATH);
  const now = Date.now();

  const failOnStranded = process.argv.includes('--fail-on-stranded');
  const {
    batch, closedBackfill, closedEligible, tooOld, exempt, givenUp, undated, stranded,
  } = selectCatchupCandidates(shows, reviews, attempts, { now });

  if (exempt.length) {
    console.log(`Exempt (noReviewsExpected, never dispatched): ${exempt.join(', ')}`);
  }
  if (givenUp.length) {
    console.log(`Given up (attempt budget exhausted): ${givenUp.join(', ')}`);
  }
  if (tooOld.length) {
    console.log(`::warning::catchup-zero-review-shows: ${tooOld.length} zero-review show(s) past the 90-day age bound will NOT be re-dispatched — this is a status/data problem, not a discovery gap: ${tooOld.join(', ')}`);
  }
  if (closedEligible.length) {
    console.log(`Closed, never attempted (one try each, ${closedBackfill.length} this batch): ${closedEligible.join(', ')}`);
  }
  if (undated.length) {
    console.log(`::warning::catchup-zero-review-shows: ${undated.length} open/closed zero-review show(s) have no openingDate, previewsStartDate or closingDate, so they can never be gathered. Set openingDate or previewsStartDate in shows.json (or noReviewsExpected): ${undated.join(', ')}`);
  }
  const waiting = stranded.filter((id) => !undated.includes(id));
  if (waiting.length) {
    console.log(`::warning::catchup-zero-review-shows: ${waiting.length} zero-review show(s) stranded (open and left out 14+ days past grace, or closed and the 2-per-run queue will not reach it inside 90 days): ${waiting.join(', ')}`);
  }
  console.log(batch.length
    ? `Found ${batch.length} show(s) with 0 reviews needing collection: ${batch.join(', ')}`
    : 'No zero-review gap shows found');

  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    fs.appendFileSync(outputPath, `gap_shows=${batch.join(',')}\n`);
  } else {
    // Local/manual run — no $GITHUB_OUTPUT to write to. Prefixed so a human
    // or script can grep it unambiguously instead of guessing at "the last line".
    console.log(`GAP_SHOWS=${batch.join(',')}`);
  }
  if (failOnStranded && stranded.length) {
    console.log(`::error::catchup-zero-review-shows: ${stranded.length} stranded zero-review show(s) (see warnings above)`);
    process.exitCode = 1;
  }
}

main();
