#!/usr/bin/env node
/**
 * Pre-deploy data integrity check.
 * Runs before every Vercel build to catch data problems that would cause
 * visible site issues. Focused and fast — only checks critical invariants.
 *
 * Exit codes:
 *   0 = pass (deploy proceeds)
 *   1 = fail (deploy aborted)
 */

const fs = require('fs');
const path = require('path');

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const REVIEWS_PATH = path.join(__dirname, '..', 'data', 'reviews.json');

let errors = 0;

function fail(msg) {
  errors++;
  console.error(`❌ ${msg}`);
}

function ok(msg) {
  console.log(`✅ ${msg}`);
}

function warn(msg) {
  console.log(`⚠️  ${msg}`);
}

// ─────────────────────────────────────────────
// 1. shows.json: status/date contradictions
// ─────────────────────────────────────────────
try {
  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const shows = showsData.shows || showsData;
  if (!Array.isArray(shows)) throw new Error('shows.json is not an array');

  const today = new Date().toISOString().slice(0, 10);
  let statusIssues = 0;

  for (const show of shows) {
    // A show marked "closed" whose closing date hasn't passed = something is wrong.
    // This is the exact bug that caused Spelling Bee to disappear.
    if (show.status === 'closed' && show.closingDate && show.closingDate > today) {
      fail(`"${show.title}" (${show.id}) is marked closed but closingDate ${show.closingDate} is in the future`);
      statusIssues++;
    }
  }

  if (statusIssues === 0) {
    ok(`Show status/date integrity: ${shows.length} shows checked, no contradictions`);
  }

  // Basic show count sanity check
  if (shows.length < 500) {
    fail(`Only ${shows.length} shows in shows.json (expected 700+). Data may be truncated.`);
  } else {
    ok(`Show count: ${shows.length}`);
  }

} catch (e) {
  fail(`Cannot read/parse shows.json: ${e.message}`);
}

// ─────────────────────────────────────────────
// 2. reviews.json: minimum review count
// ─────────────────────────────────────────────
try {
  const reviewsData = JSON.parse(fs.readFileSync(REVIEWS_PATH, 'utf8'));
  const reviews = reviewsData.reviews || reviewsData;
  if (!Array.isArray(reviews)) throw new Error('reviews.json is not an array');

  if (reviews.length < 10000) {
    fail(`Only ${reviews.length} reviews in reviews.json (expected 14,000+). Data may be incomplete.`);
  } else {
    ok(`Review count: ${reviews.length}`);
  }

} catch (e) {
  fail(`Cannot read/parse reviews.json: ${e.message}`);
}

// ─────────────────────────────────────────────
// Result
// ─────────────────────────────────────────────
console.log('');
if (errors > 0) {
  console.error(`🚨 PRE-DEPLOY CHECK FAILED: ${errors} critical issue(s) found. Deploy aborted.`);
  process.exit(1);
} else {
  console.log('✅ Pre-deploy check passed. Safe to build.');
  process.exit(0);
}
