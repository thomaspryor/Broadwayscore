#!/usr/bin/env node
/**
 * One-time cleanup of failed-fetches.json
 *
 * Removes accumulated cruft: orphan entries, duplicate reviewIds,
 * social media URLs, invalid URLs, dead domains, aggregator pages,
 * and entries past retirement threshold.
 *
 * Usage:
 *   node scripts/cleanup-failed-fetches.js --dry-run   # Preview changes
 *   node scripts/cleanup-failed-fetches.js              # Apply changes
 */

const fs = require('fs');
const path = require('path');
const { safeWriteReview } = require('./lib/review-write-guard');

const DRY_RUN = process.argv.includes('--dry-run');
const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const FAILED_FETCHES_PATH = path.join(REVIEW_TEXTS_DIR, 'failed-fetches.json');

// Domains that can never return review text
const SOCIAL_MEDIA_DOMAINS = new Set([
  'facebook.com', 'www.facebook.com', 'm.facebook.com',
  'youtube.com', 'www.youtube.com',
  'instagram.com', 'www.instagram.com',
  'twitter.com', 'www.twitter.com', 'x.com', 'www.x.com',
]);

// Domains where the entire site is dead
const DEAD_DOMAINS = new Set([
  'jasonraize.net', 'www.jasonraize.net',
]);

// Aggregator domains whose entries are always index/roundup pages.
// NYTG removed 2026-04-22 (Tier 2 Fix 9 completion): NYTG publishes original
// reviews (Kyle Turner, Allison Considine, etc.) at /reviews/<slug>. A failed
// fetch is a fetch failure, not evidence the URL is a listing page. Let the
// retirement-threshold path handle genuinely dead URLs instead of silently
// wrong_content-flagging every failed NYTG fetch.
const AGGREGATOR_DOMAINS = new Set([]);

// Retirement thresholds (must match collect-review-texts.js lines 4896-4901)
const THRESHOLDS = {
  url_dead_404: 3,
  url_dead_410: 3,
  garbage_content: 3,
  default: 5,
};

function getThreshold(reason) {
  return THRESHOLDS[reason] || THRESHOLDS.default;
}

function getDomain(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isInvalidUrl(url) {
  if (!url) return true;
  if (url.startsWith('/') || url.startsWith('../') || url.startsWith('./')) return true;
  try {
    new URL(url);
    return false;
  } catch {
    return true;
  }
}

function domainMatches(hostname, domainSet) {
  if (!hostname) return false;
  for (const d of domainSet) {
    if (hostname === d || hostname.endsWith('.' + d)) return true;
  }
  return false;
}

function setSourceFileReason(reviewId, reason, detail) {
  const filePath = path.join(REVIEW_TEXTS_DIR, reviewId);
  if (!fs.existsSync(filePath)) return false;
  if (DRY_RUN) return true;

  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    data.incompleteReason = reason;
    data.incompleteDetail = detail;
    safeWriteReview(filePath, data);
    return true;
  } catch {
    return false;
  }
}

// --- Main ---

if (!fs.existsSync(FAILED_FETCHES_PATH)) {
  console.error('failed-fetches.json not found at', FAILED_FETCHES_PATH);
  process.exit(1);
}

const entries = JSON.parse(fs.readFileSync(FAILED_FETCHES_PATH, 'utf8'));
console.log(`\nLoaded ${entries.length} entries from failed-fetches.json`);
if (DRY_RUN) console.log('=== DRY RUN — no files will be modified ===\n');

const stats = {
  orphans: 0,
  duplicates: 0,
  socialMedia: 0,
  invalidUrls: 0,
  deadDomains: 0,
  aggregatorPages: 0,
  pastThreshold: 0,
  sourceFilesModified: 0,
  kept: 0,
};

const removeReasons = new Map(); // reviewId -> reason for removal

// Step a: Identify orphan entries (source file doesn't exist)
for (const entry of entries) {
  const filePath = path.join(REVIEW_TEXTS_DIR, entry.reviewId);
  if (!fs.existsSync(filePath)) {
    removeReasons.set(entry.reviewId + '::' + (entry.lastFailedAt || ''), 'orphan');
    stats.orphans++;
  }
}

// Step b: Identify duplicate reviewIds (keep highest failureCount)
const byReviewId = new Map();
for (let i = 0; i < entries.length; i++) {
  const id = entries[i].reviewId;
  if (!byReviewId.has(id)) {
    byReviewId.set(id, []);
  }
  byReviewId.get(id).push(i);
}

const duplicateIndices = new Set();
for (const [id, indices] of byReviewId) {
  if (indices.length <= 1) continue;
  // Keep the entry with highest failureCount, break ties with most recent lastFailedAt
  const sorted = indices.sort((a, b) => {
    const countDiff = (entries[b].failureCount || 1) - (entries[a].failureCount || 1);
    if (countDiff !== 0) return countDiff;
    return (entries[b].lastFailedAt || '').localeCompare(entries[a].lastFailedAt || '');
  });
  // Mark all but the first (best) for removal
  for (let k = 1; k < sorted.length; k++) {
    duplicateIndices.add(sorted[k]);
    stats.duplicates++;
  }
}

// Step c-f: Identify domain-based removals
for (const entry of entries) {
  const key = entry.reviewId + '::' + (entry.lastFailedAt || '');
  if (removeReasons.has(key)) continue; // Already marked for removal

  const domain = getDomain(entry.url);

  // Step c: Social media
  if (domain && domainMatches(domain, SOCIAL_MEDIA_DOMAINS)) {
    removeReasons.set(key, 'social_media');
    stats.socialMedia++;
    if (setSourceFileReason(entry.reviewId, 'wrong_content', 'Social media URL (not a review)')) {
      stats.sourceFilesModified++;
    }
    continue;
  }

  // Step d: Invalid/relative URLs
  if (isInvalidUrl(entry.url)) {
    removeReasons.set(key, 'invalid_url');
    stats.invalidUrls++;
    if (setSourceFileReason(entry.reviewId, 'no_url', `Invalid/relative URL: ${entry.url}`)) {
      stats.sourceFilesModified++;
    }
    continue;
  }

  // Step e: Dead domains
  if (domain && domainMatches(domain, DEAD_DOMAINS)) {
    removeReasons.set(key, 'dead_domain');
    stats.deadDomains++;
    // Source files already have incompleteReason from prior collection runs
    continue;
  }

  // Step f: Aggregator pages
  if (domain && domainMatches(domain, AGGREGATOR_DOMAINS)) {
    removeReasons.set(key, 'aggregator_page');
    stats.aggregatorPages++;
    if (setSourceFileReason(entry.reviewId, 'wrong_content', `Aggregator index page (${domain})`)) {
      stats.sourceFilesModified++;
    }
    continue;
  }
}

// Step g: Identify entries past retirement threshold
// (Must run after dedup to use correct failureCounts)
for (let i = 0; i < entries.length; i++) {
  const entry = entries[i];
  const key = entry.reviewId + '::' + (entry.lastFailedAt || '');
  if (removeReasons.has(key) || duplicateIndices.has(i)) continue;

  const count = entry.failureCount || 1;
  const threshold = getThreshold(entry.failureReason);
  if (count >= threshold) {
    removeReasons.set(key, 'past_threshold');
    stats.pastThreshold++;
  }
}

// Build the filtered list
const kept = [];
for (let i = 0; i < entries.length; i++) {
  if (duplicateIndices.has(i)) continue;
  const entry = entries[i];
  const key = entry.reviewId + '::' + (entry.lastFailedAt || '');
  if (removeReasons.has(key)) continue;
  kept.push(entry);
}
stats.kept = kept.length;

// Report
console.log('=== Cleanup Summary ===');
console.log(`  Orphan entries removed:          ${stats.orphans}`);
console.log(`  Duplicate reviewIds collapsed:   ${stats.duplicates}`);
console.log(`  Social media entries removed:    ${stats.socialMedia}`);
console.log(`  Invalid URL entries removed:     ${stats.invalidUrls}`);
console.log(`  Dead domain entries removed:     ${stats.deadDomains}`);
console.log(`  Aggregator page entries removed: ${stats.aggregatorPages}`);
console.log(`  Past-threshold entries removed:  ${stats.pastThreshold}`);
console.log(`  Source files modified:           ${stats.sourceFilesModified}`);
console.log(`  ────────────────────────────────`);
console.log(`  Total removed: ${entries.length - stats.kept}`);
console.log(`  Entries remaining: ${stats.kept}`);

// Show samples of what's being kept
if (kept.length > 0) {
  console.log(`\n=== Sample of remaining entries (first 10) ===`);
  const domainCounts = {};
  for (const e of kept) {
    const d = getDomain(e.url) || 'unknown';
    domainCounts[d] = (domainCounts[d] || 0) + 1;
  }
  Object.entries(domainCounts).sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([d, c]) => {
    console.log(`  ${d}: ${c}`);
  });
}

// Write if not dry run
if (!DRY_RUN) {
  fs.writeFileSync(FAILED_FETCHES_PATH, JSON.stringify(kept, null, 2));
  console.log(`\n✅ Written ${kept.length} entries to failed-fetches.json`);
} else {
  console.log(`\n🔍 Dry run complete — no files modified`);
}
