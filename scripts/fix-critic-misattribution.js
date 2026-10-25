#!/usr/bin/env node

/**
 * Fix Critic Misattribution in reviews.json
 *
 * PROBLEM: Web search collection incorrectly attributed reviews to critics
 * who don't write for those outlets. For example:
 * - Jesse Green (NYT critic) appearing under Variety, TheaterMania
 * - Peter Marks (WashPost critic) appearing under Variety
 * - Adam Feldman (Time Out critic) appearing under TheaterMania
 *
 * This script:
 * 1. Identifies known critic → outlet mappings
 * 2. Removes reviews where a known critic is misattributed to wrong outlet
 * 3. Logs all removals for audit
 *
 * Usage: node scripts/fix-critic-misattribution.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const REVIEWS_PATH = path.join(__dirname, '../data/reviews.json');
const dryRun = process.argv.includes('--dry-run');

// Known critic → outlet mappings (primary affiliation)
// If a critic appears at a different outlet, it's likely misattribution
const KNOWN_CRITICS = {
  'jesse green': ['the new york times', 'nytimes', 'nyt'],
  'maya phillips': ['the new york times', 'nytimes', 'nyt'],
  'peter marks': ['the washington post', 'washington post', 'washpost'],
  'adam feldman': ['time out', 'time out new york', 'timeout'],
  'charles isherwood': ['the wall street journal', 'wsj'], // Now WSJ, formerly NYT
  'ben brantley': ['the new york times', 'nytimes', 'nyt'], // Retired but NYT
  'frank scheck': ['the hollywood reporter', 'hollywood reporter'],
  'david rooney': ['the hollywood reporter', 'hollywood reporter'],
  'helen shaw': ['vulture', 'new york magazine'],
  'sara holdren': ['vulture', 'new york magazine'],
  'johnny oleksinski': ['new york post', 'nypost'],
  'chris jones': ['chicago tribune', 'chicagotribune'],
  'tim teeman': ['the daily beast', 'daily beast'],
  'greg evans': ['deadline'],
  'jeremy gerard': ['deadline'],
  'marilyn stasio': ['variety'],
  'david cote': ['observer'],
  'zachary stewart': ['theatermania'],
  'david gordon': ['theatermania'],
};

console.log('=== Fix Critic Misattribution ===');
console.log('Mode:', dryRun ? 'DRY RUN' : 'LIVE');
console.log('');

const reviewsData = JSON.parse(fs.readFileSync(REVIEWS_PATH, 'utf8'));
const reviews = reviewsData.reviews;

console.log('Total reviews before:', reviews.length);

const fixed = [];
const removed = [];

reviews.forEach(r => {
  const criticLower = (r.criticName || '').toLowerCase().trim();
  const outletLower = (r.outlet || '').toLowerCase().trim();

  // Check if this is a known critic
  if (KNOWN_CRITICS[criticLower]) {
    const allowedOutlets = KNOWN_CRITICS[criticLower];
    const isAllowed = allowedOutlets.some(o => outletLower.includes(o) || o.includes(outletLower));

    if (!isAllowed) {
      // Misattribution - this critic doesn't write for this outlet
      removed.push({
        showId: r.showId,
        outlet: r.outlet,
        critic: r.criticName,
        allowedOutlets: allowedOutlets.join(', '),
        url: r.url
      });
      return; // Don't add to fixed
    }
  }

  fixed.push(r);
});

console.log('Reviews removed (misattribution):', removed.length);
console.log('Reviews after fix:', fixed.length);
console.log('');

if (removed.length > 0) {
  console.log('Removed reviews:');
  removed.forEach(r => {
    console.log(`  ${r.showId}: ${r.critic} at ${r.outlet} (should be: ${r.allowedOutlets})`);
  });
}

if (!dryRun && removed.length > 0) {
  // Save fixed reviews
  reviewsData.reviews = fixed;
  reviewsData._meta = reviewsData._meta || {};
  reviewsData._meta.lastMisattributionFix = new Date().toISOString();
  reviewsData._meta.misattributionsRemoved = removed.length;

  fs.writeFileSync(REVIEWS_PATH, JSON.stringify(reviewsData, null, 2));
  console.log('');
  console.log('✅ Saved fixed reviews.json');

  // Save removal log
  const logPath = path.join(__dirname, '../data/audit/misattribution-log.json');
  const logDir = path.dirname(logPath);
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

  fs.writeFileSync(logPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    removedCount: removed.length,
    beforeCount: reviews.length,
    afterCount: fixed.length,
    removed
  }, null, 2));
  console.log('✅ Saved removal log to data/audit/misattribution-log.json');
}
