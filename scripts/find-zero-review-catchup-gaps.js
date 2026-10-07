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
 * Usage: node scripts/find-zero-review-catchup-gaps.js
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

  const { batch, tooOld, exempt, givenUp } = selectCatchupCandidates(shows, reviews, attempts, { now });

  if (exempt.length) {
    console.log(`Exempt (noReviewsExpected, never dispatched): ${exempt.join(', ')}`);
  }
  if (givenUp.length) {
    console.log(`Given up (attempt budget exhausted): ${givenUp.join(', ')}`);
  }
  if (tooOld.length) {
    console.log(`::warning::catchup-zero-review-shows: ${tooOld.length} open zero-review show(s) older than the 90-day age bound will NOT be re-dispatched — this is a status/data problem, not a discovery gap: ${tooOld.join(', ')}`);
  }
  console.log(batch.length
    ? `Found ${batch.length} open show(s) with 0 reviews needing collection: ${batch.join(', ')}`
    : 'No zero-review gap shows found');

  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    fs.appendFileSync(outputPath, `gap_shows=${batch.join(',')}\n`);
  } else {
    // Local/manual run — no $GITHUB_OUTPUT to write to. Prefixed so a human
    // or script can grep it unambiguously instead of guessing at "the last line".
    console.log(`GAP_SHOWS=${batch.join(',')}`);
  }
}

main();
