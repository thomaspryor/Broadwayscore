#!/usr/bin/env node
/**
 * find-zero-review-catchup-gaps.js
 *
 * CLI wrapper around scripts/lib/zero-review-catchup.js for
 * update-show-status.yml's catchup-zero-review-shows job (BRO-3389).
 *
 * Prints the comma-separated batch of show ids to dispatch gather-reviews
 * for on the LAST stdout line (the workflow captures it via $GITHUB_OUTPUT).
 * Every other line is diagnostic. Updates data/audit/zero-review-catchup-attempts.json
 * with a fresh attempt stamp for every id in the batch — the workflow commits
 * that file after this script runs.
 *
 * Usage: node scripts/find-zero-review-catchup-gaps.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { selectCatchupCandidates } = require('./lib/zero-review-catchup');
const { loadAttempts, recordAttempts } = require('./lib/zero-review-catchup-attempts');

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

  if (batch.length) {
    console.log(`Found ${batch.length} open show(s) with 0 reviews needing collection`);
    recordAttempts(ATTEMPTS_PATH, batch, now);
  } else {
    console.log('No zero-review gap shows found');
  }

  // Last line: the batch for $GITHUB_OUTPUT to capture.
  console.log(batch.join(','));
}

main();
