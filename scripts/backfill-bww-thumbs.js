#!/usr/bin/env node
/**
 * backfill-bww-thumbs.js — Extract BWW thumb data from archived roundup HTML
 * and write it to existing review source files.
 *
 * BWW new-format roundups have per-review thumb images:
 *   uptrans.png → Up, middletrans.png → Meh, downtrans.png → Down
 *
 * Each icon is paired to the review whose critic name follows it on the page
 * (scripts/lib/bww-thumb-pairing.js, BRO-5674).
 *
 * Usage: node scripts/backfill-bww-thumbs.js [--dry-run] [--verbose] [--correct] [--shows=a,b]
 *   --correct  also overwrite a stored bwwThumb that disagrees with the page
 *              (index pairing misattributed some, BRO-5681)
 */

const { isReviewTextFile } = require('./lib/review-text-sidecars');
const fs = require('fs');
const path = require('path');
const { normalizeOutlet, normalizeCritic } = require('./lib/review-normalization');
const { parseBwwPostingAuthor } = require('./lib/bww-jsonld-author');
const { findMatchingReviewFile } = require('./lib/review-file-match');
const { extractBwwThumbIcons, pairBwwThumbsByCritic } = require('./lib/bww-thumb-pairing');

const ARCHIVE_DIR = path.join(__dirname, '..', 'data', 'aggregator-archive', 'bww-roundups');
const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const VERBOSE = args.includes('--verbose');
const CORRECT = args.includes('--correct');
const SHOWS = (args.find(a => a.startsWith('--shows=')) || '').slice('--shows='.length).split(',').filter(Boolean);

let totalArchives = 0, archivesWithThumbs = 0;
let reviewsParsed = 0, thumbsMatched = 0, thumbsWritten = 0, alreadyHadThumb = 0, thumbsCorrected = 0;

function log(msg) { if (VERBOSE) console.log(msg); }

// Extract reviews + thumbs from a BWW roundup HTML archive
function extractReviewsWithThumbs(html) {
  const reviews = [];

  // Review icons, one per <img> (BRO-5674: the old flat filename scan counted
  // srcset repeats and missed the uptrans2.png suffix).
  const thumbs = extractBwwThumbIcons(html);

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
        // Shared with gather-reviews.js (BRO-3345): one parser, no phantom outlets.
        const { outletRaw, criticName } = parseBwwPostingAuthor(posting);

        if (!outletRaw) continue;

        reviews.push({
          outletId: normalizeOutlet(outletRaw),
          criticName: criticName || 'unknown',
          criticNorm: normalizeCritic(criticName || 'unknown'),
        });
      }
    } catch (e) {}
  }

  // Pair each review with the icon whose following text names its critic
  // (BRO-5674: index pairing misattributed thumbs, see bww-thumb-pairing.js).
  const byCritic = pairBwwThumbsByCritic(thumbs, reviews);
  const paired = [];
  reviews.forEach((r, i) => { if (byCritic[i]) paired.push({ ...r, bwwThumb: byCritic[i] }); });

  return paired.length > 0 ? paired : null;
}

// Find matching source file for a review
// Returns { file, how }: how is 'exact' | 'prefix' | 'family' | 'outlet-only'.
function findMatchingFile(showId, outletId, criticNorm) {
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(showDir)) return null;

  const files = fs.readdirSync(showDir).filter(f => isReviewTextFile(f));

  // Exact match: outlet--critic
  if (criticNorm && criticNorm !== 'unknown') {
    const expectedPattern = `${outletId}--${criticNorm}`;
    for (const file of files) {
      if (file === expectedPattern + '.json') return { file: path.join(showDir, file), how: 'exact' };
      if (file.startsWith(expectedPattern + '-')) return { file: path.join(showDir, file), how: 'prefix' };
    }
    // Same outlet family (edition variants like timeout / timeout-london), never
    // a critic-name-only match across outlets (BRO-3943).
    const familyMatch = findMatchingReviewFile(files, outletId, criticNorm, normalizeOutlet);
    if (familyMatch) return { file: path.join(showDir, familyMatch), how: 'family' };
  }

  // When critic is unknown, match by outlet — but only if there's exactly one file for that outlet
  const outletMatches = files.filter(f => f.startsWith(outletId + '--'));
  if (outletMatches.length === 1) {
    return { file: path.join(showDir, outletMatches[0]), how: 'outlet-only' };
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
  if (SHOWS.length && !SHOWS.includes(showId)) continue;
  const html = fs.readFileSync(path.join(ARCHIVE_DIR, file), 'utf8');

  const reviews = extractReviewsWithThumbs(html);
  if (!reviews) continue;

  archivesWithThumbs++;
  log(`${showId}: ${reviews.length} reviews with thumbs`);

  for (const review of reviews) {
    reviewsParsed++;
    const match = findMatchingFile(showId, review.outletId, review.criticNorm);
    const filePath = match && match.file;
    if (!filePath) {
      log(`  ✗ No match: ${review.outletId}--${review.criticNorm} (${review.bwwThumb})`);
      continue;
    }

    thumbsMatched++;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      if (data.bwwThumb === review.bwwThumb) {
        alreadyHadThumb++;
        continue;
      }
      // --correct overwrites only a file that is provably this critic's: an
      // exact or same-outlet-family name match, never a name prefix or the
      // lone file at the outlet (BRO-5681 review: those can be another critic).
      if (data.bwwThumb && (!CORRECT || !['exact', 'family'].includes(match.how))) {
        alreadyHadThumb++;
        log(`  ○ Already has thumb: ${path.basename(filePath)} (${data.bwwThumb})`);
        continue;
      }

      if (data.bwwThumb) {
        console.log(`  ↻ ${showId}/${path.basename(filePath)}: bwwThumb ${data.bwwThumb} -> ${review.bwwThumb}`);
        data.bwwThumbNote = `BRO-5681: corrected ${data.bwwThumb} -> ${review.bwwThumb} by critic-name pairing against the archived roundup`;
        thumbsCorrected++;
      } else {
        log(`  ✓ Set bwwThumb=${review.bwwThumb}: ${path.basename(filePath)}`);
      }
      data.bwwThumb = review.bwwThumb;

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
if (CORRECT) console.log(`  of which corrected: ${thumbsCorrected}`);
if (DRY_RUN) console.log('\n(Dry run — no files modified)');
