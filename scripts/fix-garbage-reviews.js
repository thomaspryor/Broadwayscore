#!/usr/bin/env node

/**
 * Fix Garbage Reviews Script
 *
 * Identifies reviews where fullText contains garbage (paywalls, ad blocker messages, etc.)
 * and either:
 * 1. Clears garbage fullText and sets up for excerpt-based LLM scoring
 * 2. Flags reviews needing re-scraping (no excerpts available)
 *
 * Usage:
 *   node scripts/fix-garbage-reviews.js [--dry-run] [--show=show-id]
 *
 * Options:
 *   --dry-run     Show what would be changed without modifying files
 *   --show=ID     Only process specific show
 *   --verbose     Show detailed output
 */

const fs = require('fs');
const path = require('path');

// Import content quality module
const { assessTextQuality } = require('./lib/content-quality.js');

const REVIEW_TEXTS_DIR = path.join(__dirname, '../data/review-texts');
const REPORT_PATH = path.join(__dirname, '../data/garbage-reviews-report.json');

// Parse command line arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const verbose = args.includes('--verbose');
const showArg = args.find(a => a.startsWith('--show='));
const filterShowId = showArg ? showArg.split('=')[1] : null;

// Garbage patterns (quick check before full assessment)
const GARBAGE_PATTERNS = [
  /ad ?block(er)?/i,
  /please turn off/i,
  /whitelist.*browser/i,
  /subscribe to (continue|read)/i,
  /sign in to (continue|read)/i,
  /you('re| are) using an? (ad ?block)/i,
  /to read our full stories/i,
  /advertising revenue helps support/i,
  /privacy policy.*terms of use/i,
  /©\s*\d{4}.*all rights reserved/i,
  /we noticed you/i,
  /page not found/i,
  /404 error/i,
  /access denied/i,
];

function isGarbageQuick(text) {
  if (!text || text.length < 50) return { isGarbage: true, reason: 'Too short' };

  const lower = text.toLowerCase();
  for (const pattern of GARBAGE_PATTERNS) {
    if (pattern.test(text)) {
      return { isGarbage: true, reason: pattern.toString() };
    }
  }

  return { isGarbage: false };
}

function getExcerpts(data) {
  const excerpts = [];
  if (data.bwwExcerpt && data.bwwExcerpt.length >= 50) {
    excerpts.push({ source: 'bww', text: data.bwwExcerpt });
  }
  if (data.dtliExcerpt && data.dtliExcerpt.length >= 50 && data.dtliExcerpt !== data.bwwExcerpt) {
    excerpts.push({ source: 'dtli', text: data.dtliExcerpt });
  }
  if (data.showScoreExcerpt && data.showScoreExcerpt.length >= 50 &&
      data.showScoreExcerpt !== data.bwwExcerpt && data.showScoreExcerpt !== data.dtliExcerpt) {
    excerpts.push({ source: 'showScore', text: data.showScoreExcerpt });
  }
  return excerpts;
}

function getAllReviewFiles() {
  const files = [];

  if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
    return files;
  }

  const shows = filterShowId
    ? [filterShowId]
    : fs.readdirSync(REVIEW_TEXTS_DIR).filter(f =>
        fs.statSync(path.join(REVIEW_TEXTS_DIR, f)).isDirectory()
      );

  for (const show of shows) {
    const showDir = path.join(REVIEW_TEXTS_DIR, show);
    if (!fs.existsSync(showDir)) continue;

    const reviewFiles = fs.readdirSync(showDir).filter(f =>
      f.endsWith('.json') && !f.includes('failed-fetches')
    );

    for (const file of reviewFiles) {
      try {
        const filePath = path.join(showDir, file);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        files.push({ path: filePath, data, showId: show });
      } catch (e) {
        // Skip malformed files
      }
    }
  }

  return files;
}

async function main() {
  console.log('=== Fix Garbage Reviews ===\n');
  if (dryRun) console.log('DRY RUN - no files will be modified\n');

  const allFiles = getAllReviewFiles();
  console.log(`Found ${allFiles.length} review files to check\n`);

  const stats = {
    total: allFiles.length,
    garbageWithExcerpts: 0,
    garbageNoExcerpts: 0,
    alreadyClean: 0,
    noFullText: 0,
    fixed: 0
  };

  const garbageWithExcerpts = [];
  const garbageNoExcerpts = [];
  const fixed = [];

  for (const { path: filePath, data, showId } of allFiles) {
    // Skip if no fullText
    if (!data.fullText || data.fullText.length < 50) {
      stats.noFullText++;
      continue;
    }

    // Quick garbage check
    const quickCheck = isGarbageQuick(data.fullText);

    // If quick check didn't find garbage, do full assessment
    let isGarbage = quickCheck.isGarbage;
    let reason = quickCheck.reason;

    if (!isGarbage) {
      const showTitle = showId.replace(/-\d{4}$/, '').replace(/-/g, ' ');
      const qualityResult = assessTextQuality(data.fullText, showTitle);

      if (qualityResult.quality === 'garbage' && qualityResult.confidence === 'high') {
        isGarbage = true;
        reason = qualityResult.issues[0] || 'Content quality check failed';
      }
    }

    if (!isGarbage) {
      stats.alreadyClean++;
      continue;
    }

    // Found garbage - check for excerpts
    const excerpts = getExcerpts(data);
    const outletCritic = path.basename(filePath, '.json');

    if (excerpts.length > 0) {
      stats.garbageWithExcerpts++;
      garbageWithExcerpts.push({
        showId,
        file: outletCritic,
        path: filePath,
        reason,
        excerpts: excerpts.map(e => e.source),
        bestExcerptLength: Math.max(...excerpts.map(e => e.text.length))
      });

      if (!dryRun) {
        // Clear garbage fullText and mark for excerpt-based scoring
        const originalFullText = data.fullText;

        // Store original garbage text for reference
        data.garbageFullText = originalFullText;
        data.garbageReason = reason;
        data.garbageFixedAt = new Date().toISOString();

        // Clear fullText so LLM scoring will use excerpts
        delete data.fullText;
        data.textQuality = 'excerpt_only';
        data.textStatus = 'garbage_cleared';
        data.isFullReview = false;

        fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
        stats.fixed++;
        fixed.push({ showId, file: outletCritic, reason });
      }

      if (verbose) {
        console.log(`✓ ${showId}/${outletCritic} - GARBAGE (has ${excerpts.length} excerpts)`);
        console.log(`  Reason: ${reason}`);
      }
    } else {
      stats.garbageNoExcerpts++;
      garbageNoExcerpts.push({
        showId,
        file: outletCritic,
        path: filePath,
        url: data.url,
        reason,
        hasThumb: !!(data.dtliThumb || data.bwwThumb)
      });

      if (verbose) {
        console.log(`✗ ${showId}/${outletCritic} - GARBAGE (NO EXCERPTS - needs re-scrape)`);
        console.log(`  Reason: ${reason}`);
        console.log(`  URL: ${data.url}`);
      }
    }
  }

  // Summary
  console.log('\n=== Summary ===');
  console.log(`Total files checked: ${stats.total}`);
  console.log(`No fullText: ${stats.noFullText}`);
  console.log(`Already clean: ${stats.alreadyClean}`);
  console.log(`Garbage with excerpts: ${stats.garbageWithExcerpts} (fixable)`);
  console.log(`Garbage no excerpts: ${stats.garbageNoExcerpts} (needs re-scrape)`);
  if (!dryRun) {
    console.log(`Fixed: ${stats.fixed}`);
  }

  // Save report
  const report = {
    generatedAt: new Date().toISOString(),
    dryRun,
    stats,
    garbageWithExcerpts,
    garbageNoExcerpts,
    fixed: dryRun ? [] : fixed
  };

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
  console.log(`\nReport saved to: ${REPORT_PATH}`);

  // Action items
  if (garbageWithExcerpts.length > 0 && dryRun) {
    console.log(`\n⚠️  Run without --dry-run to fix ${garbageWithExcerpts.length} garbage reviews with excerpts`);
  }

  if (garbageNoExcerpts.length > 0) {
    console.log(`\n⚠️  ${garbageNoExcerpts.length} reviews need re-scraping (no excerpts available)`);
    console.log('   These can be re-scraped with: gh workflow run "Collect Review Texts"');
    console.log('   Or manually fixed by adding excerpts from aggregator pages');
  }

  if (fixed.length > 0) {
    console.log(`\n✅ Fixed ${fixed.length} reviews - run LLM scoring to score them:`);
    console.log('   gh workflow run "LLM Ensemble Score Reviews"');
  }
}

main().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
