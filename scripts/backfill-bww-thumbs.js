#!/usr/bin/env node
/**
 * backfill-bww-thumbs.js — Extract BWW thumb data from archived roundup HTML
 * and write it to existing review source files.
 *
 * BWW new-format roundups have per-review thumb images:
 *   uptrans.png → Up, middletrans.png → Meh, downtrans.png → Down
 *
 * These appear in <p> tags in the same order as the BlogPosting JSON-LD entries.
 *
 * Usage: node scripts/backfill-bww-thumbs.js [--dry-run] [--verbose]
 */

const fs = require('fs');
const path = require('path');
const { normalizeOutlet, normalizeCritic } = require('./lib/review-normalization');

const ARCHIVE_DIR = path.join(__dirname, '..', 'data', 'aggregator-archive', 'bww-roundups');
const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const VERBOSE = args.includes('--verbose');

let totalArchives = 0, archivesWithThumbs = 0;
let reviewsParsed = 0, thumbsMatched = 0, thumbsWritten = 0, alreadyHadThumb = 0;

function log(msg) { if (VERBOSE) console.log(msg); }

// Extract reviews + thumbs from a BWW roundup HTML archive
function extractReviewsWithThumbs(html) {
  const reviews = [];

  // Extract thumbs from HTML img tags (in order)
  const thumbPattern = /(?:uptrans|middletrans|downtrans)\.png/g;
  const thumbs = [];
  let match;
  while ((match = thumbPattern.exec(html)) !== null) {
    const img = match[0];
    if (img.includes('uptrans')) thumbs.push('Up');
    else if (img.includes('middletrans')) thumbs.push('Meh');
    else if (img.includes('downtrans')) thumbs.push('Down');
  }

  if (thumbs.length === 0) return null;

  // Extract reviews from JSON-LD (same order as thumbs)
  // Newer archives use LiveBlogPosting with liveBlogUpdate[] containing BlogPosting entries
  // Older archives use standalone BlogPosting entries
  const scriptMatches = html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g);
  for (const scriptMatch of scriptMatches) {
    try {
      const cleanedJson = scriptMatch[1].replace(/[\x00-\x1F\x7F]/g, ' ');
      const json = JSON.parse(cleanedJson);

      // Collect BlogPosting entries from either format
      const postings = [];
      if (json['@type'] === 'BlogPosting') {
        postings.push(json);
      } else if (json['@type'] === 'LiveBlogPosting' && Array.isArray(json.liveBlogUpdate)) {
        for (const entry of json.liveBlogUpdate) {
          if (entry['@type'] === 'BlogPosting') postings.push(entry);
        }
      }

      for (const posting of postings) {
        // Two formats:
        // 1. Standalone BlogPosting: author.name = "Outlet - Critic"
        // 2. LiveBlogPosting entries: headline = "Outlet - Review Title"
        let outletRaw = null;
        let criticName = null;

        if (posting.author) {
          const authorName = Array.isArray(posting.author) ? posting.author[0]?.name : posting.author?.name;
          if (authorName && authorName.includes(' - ')) {
            const parts = authorName.split(' - ');
            outletRaw = parts[0].trim();
            criticName = parts[1]?.trim() || null;
          } else if (authorName) {
            outletRaw = authorName;
          }
        } else if (posting.headline && posting.headline.includes(' - ')) {
          // LiveBlogPosting entries: "Outlet - Review Title"
          outletRaw = posting.headline.split(' - ')[0].trim();
        }

        if (!outletRaw) continue;

        reviews.push({
          outletId: normalizeOutlet(outletRaw),
          criticName: criticName || 'unknown',
          criticNorm: normalizeCritic(criticName || 'unknown'),
        });
      }
    } catch (e) {}
  }

  // Pair thumbs with reviews by position
  const paired = [];
  const count = Math.min(thumbs.length, reviews.length);
  for (let i = 0; i < count; i++) {
    paired.push({ ...reviews[i], bwwThumb: thumbs[i] });
  }

  return paired.length > 0 ? paired : null;
}

// Find matching source file for a review
function findMatchingFile(showId, outletId, criticNorm) {
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(showDir)) return null;

  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

  // Exact match: outlet--critic
  if (criticNorm && criticNorm !== 'unknown') {
    const expectedPattern = `${outletId}--${criticNorm}`;
    for (const file of files) {
      if (file.startsWith(expectedPattern + '.json') || file.startsWith(expectedPattern + '-')) {
        return path.join(showDir, file);
      }
    }
    // Try matching by critic name alone (outlet names vary)
    for (const file of files) {
      if (file.includes(`--${criticNorm}.json`)) {
        return path.join(showDir, file);
      }
    }
  }

  // When critic is unknown, match by outlet — but only if there's exactly one file for that outlet
  const outletMatches = files.filter(f => f.startsWith(outletId + '--'));
  if (outletMatches.length === 1) {
    return path.join(showDir, outletMatches[0]);
  }

  return null;
}

// Main
const archiveFiles = fs.readdirSync(ARCHIVE_DIR).filter(f => f.endsWith('.html'));
console.log(`Scanning ${archiveFiles.length} BWW roundup archives for thumb data...`);
console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}\n`);

for (const file of archiveFiles) {
  totalArchives++;
  const showId = file.replace('.html', '');
  const html = fs.readFileSync(path.join(ARCHIVE_DIR, file), 'utf8');

  const reviews = extractReviewsWithThumbs(html);
  if (!reviews) continue;

  archivesWithThumbs++;
  log(`${showId}: ${reviews.length} reviews with thumbs`);

  for (const review of reviews) {
    reviewsParsed++;
    const filePath = findMatchingFile(showId, review.outletId, review.criticNorm);
    if (!filePath) {
      log(`  ✗ No match: ${review.outletId}--${review.criticNorm} (${review.bwwThumb})`);
      continue;
    }

    thumbsMatched++;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      if (data.bwwThumb) {
        alreadyHadThumb++;
        log(`  ○ Already has thumb: ${path.basename(filePath)} (${data.bwwThumb})`);
        continue;
      }

      data.bwwThumb = review.bwwThumb;
      log(`  ✓ Set bwwThumb=${review.bwwThumb}: ${path.basename(filePath)}`);

      if (!DRY_RUN) {
        const tmp = filePath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
        fs.renameSync(tmp, filePath);
      }
      thumbsWritten++;
    } catch (e) {
      log(`  ⚠ Error: ${filePath}: ${e.message}`);
    }
  }
}

console.log('\n=== SUMMARY ===');
console.log(`Archives scanned:     ${totalArchives}`);
console.log(`Archives with thumbs: ${archivesWithThumbs}`);
console.log(`Reviews parsed:       ${reviewsParsed}`);
console.log(`Matched to files:     ${thumbsMatched}`);
console.log(`Already had thumb:    ${alreadyHadThumb}`);
console.log(`Thumbs written:       ${thumbsWritten}`);
if (DRY_RUN) console.log('\n(Dry run — no files modified)');
