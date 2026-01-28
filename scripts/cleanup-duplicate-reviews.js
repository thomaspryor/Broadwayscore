#!/usr/bin/env node
/**
 * Cleanup Duplicate Reviews (Sprint 2.2)
 *
 * Scans all review-texts directories, identifies duplicates using normalized
 * outlet/critic names, merges their data, and consolidates to single files.
 *
 * Preserves LLM scores from backup file created by backup-llm-scores.js.
 *
 * Usage:
 *   node scripts/cleanup-duplicate-reviews.js --dry-run              # Preview changes
 *   node scripts/cleanup-duplicate-reviews.js                        # Execute cleanup
 *   node scripts/cleanup-duplicate-reviews.js --similar              # Also process similar matches
 *   node scripts/cleanup-duplicate-reviews.js --show=show-id         # Process single show
 *   node scripts/cleanup-duplicate-reviews.js --use-audit            # Use duplicates-found.json from find-duplicate-reviews.js
 *
 * Options:
 *   --dry-run   Show what would be done without making changes
 *   --show=X    Only process specific show
 *   --similar   Also process partial-name matches (requires --use-audit)
 *   --use-audit Use pre-computed duplicates from find-duplicate-reviews.js
 *   --verbose   Show detailed output
 */

const fs = require('fs');
const path = require('path');
const {
  normalizeOutlet,
  normalizeCritic,
  generateReviewFilename,
  generateReviewKey,
  mergeReviews,
  getOutletDisplayName,
} = require('./lib/review-normalization');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const AUDIT_DIR = path.join(__dirname, '..', 'data', 'audit');
const DUPLICATES_FILE = path.join(AUDIT_DIR, 'duplicates-found.json');
const LLM_BACKUP_FILE = path.join(AUDIT_DIR, 'llm-scores-backup.json');

// Parse command line args
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const verbose = args.includes('--verbose');
const includeSimilar = args.includes('--similar');
const useAudit = args.includes('--use-audit');
const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];

// Stats
const stats = {
  showsProcessed: 0,
  filesScanned: 0,
  duplicatesFound: 0,
  filesMerged: 0,
  filesDeleted: 0,
  filesRenamed: 0,
  llmScoresRestored: 0,
  errors: [],
};

// LLM backup cache
let llmBackup = null;

function loadLlmBackup() {
  if (llmBackup !== null) return llmBackup;

  if (!fs.existsSync(LLM_BACKUP_FILE)) {
    console.warn(`LLM backup file not found: ${LLM_BACKUP_FILE}`);
    console.warn('LLM scores may not be preserved. Run backup-llm-scores.js first.\n');
    llmBackup = { scores: {} };
    return llmBackup;
  }

  llmBackup = JSON.parse(fs.readFileSync(LLM_BACKUP_FILE, 'utf-8'));
  console.log(`Loaded ${Object.keys(llmBackup.scores).length} LLM score backups\n`);
  return llmBackup;
}

function loadAuditDuplicates() {
  if (!fs.existsSync(DUPLICATES_FILE)) {
    console.error(`Duplicates file not found: ${DUPLICATES_FILE}`);
    console.error('Run find-duplicate-reviews.js first, or omit --use-audit flag.');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(DUPLICATES_FILE, 'utf-8'));
}

function restoreLlmScore(showId, outletId, criticSlug, review) {
  const backup = loadLlmBackup();
  const key = `${showId}|${outletId}|${criticSlug}`;

  if (backup.scores[key]) {
    const scoreData = backup.scores[key];

    if (scoreData.llmScore && scoreData.llmScore.score !== null) {
      // Only restore if current review doesn't have a score or backup is higher confidence
      if (!review.llmScore ||
          !review.llmScore.score ||
          scoreData.llmScore.confidence === 'high') {
        review.llmScore = scoreData.llmScore;
        review.llmMetadata = scoreData.llmMetadata;
        review.ensembleData = scoreData.ensembleData;
        stats.llmScoresRestored++;
        return true;
      }
    }

    if (scoreData.assignedScore !== undefined && review.assignedScore === undefined) {
      review.assignedScore = scoreData.assignedScore;
    }
  }

  return false;
}

/**
 * Process a single show directory using scanning
 */
function processShow(showId) {
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);

  if (!fs.existsSync(showDir)) {
    console.log(`  Warning: Show directory not found: ${showId}`);
    return;
  }

  const files = fs.readdirSync(showDir)
    .filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

  if (files.length === 0) {
    return;
  }

  stats.filesScanned += files.length;

  // Group files by normalized key
  const reviewGroups = new Map();

  for (const file of files) {
    try {
      const filePath = path.join(showDir, file);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      const key = generateReviewKey(data.outlet, data.criticName);
      const canonicalFilename = generateReviewFilename(data.outlet, data.criticName);

      if (!reviewGroups.has(key)) {
        reviewGroups.set(key, {
          key,
          canonicalFilename,
          files: [],
          reviews: [],
        });
      }

      reviewGroups.get(key).files.push(file);
      reviewGroups.get(key).reviews.push(data);

    } catch (err) {
      stats.errors.push(`Error reading ${showId}/${file}: ${err.message}`);
    }
  }

  // Process each group
  let showDuplicates = 0;
  let showMerged = 0;
  let showDeleted = 0;
  let showRenamed = 0;

  for (const [key, group] of reviewGroups) {
    if (group.files.length > 1) {
      // Found duplicates!
      showDuplicates += group.files.length - 1;
      stats.duplicatesFound += group.files.length - 1;

      if (verbose) {
        console.log(`  Duplicates for ${key}:`);
        group.files.forEach(f => console.log(`    - ${f}`));
      }

      // Merge all reviews into one
      let mergedReview = group.reviews[0];
      for (let i = 1; i < group.reviews.length; i++) {
        mergedReview = mergeReviews(mergedReview, group.reviews[i]);
      }

      // Normalize the outlet and critic names in the merged review
      mergedReview.outletId = normalizeOutlet(mergedReview.outlet);
      mergedReview.outlet = getOutletDisplayName(mergedReview.outletId);

      // Try to restore LLM score from backup
      const criticSlug = normalizeCritic(mergedReview.criticName);
      restoreLlmScore(showId, mergedReview.outletId, criticSlug, mergedReview);

      const canonicalPath = path.join(showDir, group.canonicalFilename);

      if (!dryRun) {
        // Write merged review to canonical filename
        fs.writeFileSync(canonicalPath, JSON.stringify(mergedReview, null, 2));
        showMerged++;
        stats.filesMerged++;

        // Delete all other files
        for (const file of group.files) {
          const filePath = path.join(showDir, file);
          if (file !== group.canonicalFilename && fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            showDeleted++;
            stats.filesDeleted++;
          }
        }
      }

    } else if (group.files.length === 1) {
      // Single file - check if it needs renaming
      const currentFile = group.files[0];
      const canonicalFilename = group.canonicalFilename;

      if (currentFile !== canonicalFilename) {
        if (verbose) {
          console.log(`  Rename: ${currentFile} -> ${canonicalFilename}`);
        }

        if (!dryRun) {
          const currentPath = path.join(showDir, currentFile);
          const canonicalPath = path.join(showDir, canonicalFilename);

          // Update the review data with normalized names
          const data = group.reviews[0];
          data.outletId = normalizeOutlet(data.outlet);
          data.outlet = getOutletDisplayName(data.outletId);

          // Try to restore LLM score from backup
          const criticSlug = normalizeCritic(data.criticName);
          restoreLlmScore(showId, data.outletId, criticSlug, data);

          // Write to canonical filename
          fs.writeFileSync(canonicalPath, JSON.stringify(data, null, 2));

          // Delete old file if different
          if (currentFile !== canonicalFilename && fs.existsSync(currentPath)) {
            fs.unlinkSync(currentPath);
          }

          showRenamed++;
          stats.filesRenamed++;
        }
      }
    }
  }

  const uniqueReviews = reviewGroups.size;
  if (showDuplicates > 0 || verbose) {
    console.log(`  ${showId}: ${files.length} files -> ${uniqueReviews} unique (${showDuplicates} duplicates merged)`);
  }

  stats.showsProcessed++;
}

/**
 * Process using pre-computed audit file (supports --similar flag)
 */
function processFromAudit() {
  const duplicates = loadAuditDuplicates();
  loadLlmBackup();

  // Filter groups based on type
  let groupsToProcess = duplicates.duplicateGroups.filter(g => g.type === 'exact-normalized');

  if (includeSimilar) {
    const similarGroups = duplicates.duplicateGroups.filter(g =>
      g.type === 'similar-critic' &&
      g.reason === 'partial-name'
    );
    groupsToProcess = [...groupsToProcess, ...similarGroups];
    console.log(`Including ${similarGroups.length} similar match groups (partial-name only)\n`);
  }

  console.log(`Found ${groupsToProcess.length} duplicate groups to process\n`);

  const showsProcessed = new Set();

  for (const group of groupsToProcess) {
    const { showId, files, canonicalFile } = group;
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);

    if (!fs.existsSync(showDir)) {
      stats.errors.push(`Show directory not found: ${showId}`);
      continue;
    }

    showsProcessed.add(showId);
    stats.duplicatesFound += files.length - 1;
    stats.filesScanned += files.length;

    console.log(`Processing: ${showId}`);
    console.log(`  Type: ${group.type}${group.reason ? ` (${group.reason})` : ''}`);
    console.log(`  Files: ${files.map(f => f.filename).join(', ')}`);
    console.log(`  Canonical: ${canonicalFile}`);

    // Load all reviews
    const reviews = [];
    for (const f of files) {
      const filePath = path.join(showDir, f.filename);
      if (fs.existsSync(filePath)) {
        try {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          reviews.push({ filename: f.filename, data });
        } catch (err) {
          stats.errors.push(`Error reading ${showId}/${f.filename}: ${err.message}`);
        }
      }
    }

    if (reviews.length === 0) {
      console.log(`  Skipping: no valid reviews found`);
      continue;
    }

    // Merge all reviews
    let merged = reviews[0].data;
    for (let i = 1; i < reviews.length; i++) {
      merged = mergeReviews(merged, reviews[i].data);
    }

    // Select best fullText
    let bestFullText = null;
    let bestFullTextLength = 0;
    for (const r of reviews) {
      if (r.data.fullText && r.data.fullText.length > bestFullTextLength) {
        const text = r.data.fullText;
        if (text.length > 100 && !text.includes('Please excuse me while')) {
          bestFullText = text;
          bestFullTextLength = text.length;
        }
      }
    }
    if (bestFullText) {
      merged.fullText = bestFullText;
      merged.isFullReview = bestFullTextLength > 500;
    }

    // Normalize
    merged.outletId = normalizeOutlet(merged.outlet);
    merged.outlet = getOutletDisplayName(merged.outletId);

    // Restore LLM scores
    const criticSlug = normalizeCritic(merged.criticName);
    restoreLlmScore(showId, merged.outletId, criticSlug, merged);

    console.log(`  Merged: fullText=${merged.fullText ? merged.fullText.length : 0} chars, llmScore=${merged.llmScore ? merged.llmScore.score : 'none'}`);

    if (!dryRun) {
      // Save merged file
      const canonicalPath = path.join(showDir, canonicalFile);
      fs.writeFileSync(canonicalPath, JSON.stringify(merged, null, 2));
      stats.filesMerged++;

      // Delete other files
      for (const r of reviews) {
        if (r.filename !== canonicalFile) {
          const filePath = path.join(showDir, r.filename);
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            stats.filesDeleted++;
            console.log(`  Deleted: ${r.filename}`);
          }
        }
      }
    }
  }

  stats.showsProcessed = showsProcessed.size;
}

/**
 * Main function
 */
function main() {
  console.log('=== CLEANUP DUPLICATE REVIEWS ===');
  console.log(dryRun ? '(DRY RUN - no changes will be made)\n' : '\n');

  if (useAudit) {
    processFromAudit();
  } else {
    // Get list of shows to process
    let shows;
    if (showFilter) {
      shows = [showFilter];
      console.log(`Processing single show: ${showFilter}\n`);
    } else {
      shows = fs.readdirSync(REVIEW_TEXTS_DIR)
        .filter(f => {
          const fullPath = path.join(REVIEW_TEXTS_DIR, f);
          return fs.statSync(fullPath).isDirectory();
        });
      console.log(`Processing ${shows.length} shows...\n`);
    }

    // Load LLM backup
    loadLlmBackup();

    // Process each show
    for (const show of shows) {
      processShow(show);
    }
  }

  // Print summary
  console.log('\n=== SUMMARY ===');
  console.log(`Shows processed: ${stats.showsProcessed}`);
  console.log(`Files scanned: ${stats.filesScanned}`);
  console.log(`Duplicates found: ${stats.duplicatesFound}`);
  if (!dryRun) {
    console.log(`Files merged: ${stats.filesMerged}`);
    console.log(`Files deleted: ${stats.filesDeleted}`);
    console.log(`Files renamed: ${stats.filesRenamed}`);
    console.log(`LLM scores restored: ${stats.llmScoresRestored}`);
  }

  if (stats.errors.length > 0) {
    console.log(`\nErrors (${stats.errors.length}):`);
    stats.errors.slice(0, 10).forEach(e => console.log(`  - ${e}`));
    if (stats.errors.length > 10) {
      console.log(`  ... and ${stats.errors.length - 10} more`);
    }
  }

  if (dryRun && stats.duplicatesFound > 0) {
    console.log('\nRun without --dry-run to apply changes.');
  }

  if (!includeSimilar && !useAudit) {
    console.log('\nTo also process similar/partial-name matches, use: --use-audit --similar');
  }
}

main();
