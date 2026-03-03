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
const WATERMARK_PATH = path.join(__dirname, '..', 'data', 'audit', 'deploy-watermark.json');

// Max allowed drop from last successful deploy (percentage).
// 916 reviews / 18,239 = 5%. We want to catch losses smaller than that.
const MAX_REVIEW_DROP_PCT = 3;
const MAX_SHOW_DROP_PCT = 3;

let errors = 0;

function fail(msg) {
  errors++;
  console.error(`❌ ${msg}`);
}

function ok(msg) {
  console.log(`✅ ${msg}`);
}

// ─────────────────────────────────────────────
// Load watermark from last successful deploy
// ─────────────────────────────────────────────
let watermark = null;
try {
  watermark = JSON.parse(fs.readFileSync(WATERMARK_PATH, 'utf8'));
} catch (e) { /* first run or missing file — use absolute floors only */ }

// ─────────────────────────────────────────────
// 1. shows.json: status/date contradictions + count
// ─────────────────────────────────────────────
let showCount = 0;
try {
  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const shows = showsData.shows || showsData;
  if (!Array.isArray(shows)) throw new Error('shows.json is not an array');
  showCount = shows.length;

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
    ok(`Show status/date integrity: ${showCount} shows checked, no contradictions`);
  }

  // Absolute floor (catastrophic data loss)
  if (showCount < 500) {
    fail(`Only ${showCount} shows (expected 700+). Data may be truncated.`);
  }
  // Regression check against watermark
  if (watermark?.showCount) {
    const lost = watermark.showCount - showCount;
    const pct = (lost / watermark.showCount * 100).toFixed(1);
    if (lost > 0 && parseFloat(pct) > MAX_SHOW_DROP_PCT) {
      fail(`Show count dropped ${lost} (${pct}%) from last deploy: ${watermark.showCount} → ${showCount}`);
    } else {
      ok(`Show count: ${showCount} (watermark: ${watermark.showCount})`);
    }
  } else {
    ok(`Show count: ${showCount} (no watermark yet)`);
  }

} catch (e) {
  fail(`Cannot read/parse shows.json: ${e.message}`);
}

// ─────────────────────────────────────────────
// 2. reviews.json: count regression check
// ─────────────────────────────────────────────
let reviewCount = 0;
try {
  const reviewsData = JSON.parse(fs.readFileSync(REVIEWS_PATH, 'utf8'));
  const reviews = reviewsData.reviews || reviewsData;
  if (!Array.isArray(reviews)) throw new Error('reviews.json is not an array');
  reviewCount = reviews.length;

  // Absolute floor (catastrophic data loss)
  if (reviewCount < 10000) {
    fail(`Only ${reviewCount} reviews (expected 14,000+). Data may be truncated.`);
  }
  // Regression check against watermark
  if (watermark?.reviewCount) {
    const lost = watermark.reviewCount - reviewCount;
    const pct = (lost / watermark.reviewCount * 100).toFixed(1);
    if (lost > 0 && parseFloat(pct) > MAX_REVIEW_DROP_PCT) {
      fail(`Review count dropped ${lost} (${pct}%) from last deploy: ${watermark.reviewCount} → ${reviewCount}`);
    } else {
      ok(`Review count: ${reviewCount} (watermark: ${watermark.reviewCount})`);
    }
  } else {
    ok(`Review count: ${reviewCount} (no watermark yet)`);
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
  // Update watermark on success — next deploy will check against these counts.
  const newWatermark = { showCount, reviewCount, updatedAt: new Date().toISOString() };
  try {
    const dir = path.dirname(WATERMARK_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(WATERMARK_PATH, JSON.stringify(newWatermark, null, 2) + '\n');
  } catch (e) {
    // Non-fatal — watermark write failure shouldn't block deploy
    console.log(`⚠️  Could not update watermark: ${e.message}`);
  }
  console.log('✅ Pre-deploy check passed. Safe to build.');
  process.exit(0);
}
