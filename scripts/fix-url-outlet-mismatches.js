#!/usr/bin/env node
/**
 * Fix URL-outlet mismatches
 *
 * Renames review files where the outlet in the filename doesn't match the URL domain.
 * For example: nydailynews--chris-jones.json with chicagotribune.com URL
 * becomes: chicagotribune--chris-jones.json
 *
 * Usage:
 *   node scripts/fix-url-outlet-mismatches.js --dry-run
 *   node scripts/fix-url-outlet-mismatches.js
 */

const fs = require('fs');
const path = require('path');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');

// URL domain to outletId mapping
const DOMAIN_TO_OUTLET = {
  'cititour.com': { outletId: 'cititour', outlet: 'Cititour' },
  'chicagotribune.com': { outletId: 'chicagotribune', outlet: 'Chicago Tribune' },
  'newyorktheater.me': { outletId: 'newyorktheater', outlet: 'New York Theater' },
  'amny.com': { outletId: 'amny', outlet: 'amNewYork' },
  'thewrap.com': { outletId: 'thewrap', outlet: 'TheWrap' },
  'theaterscene.net': { outletId: 'theaterscene', outlet: 'Theater Scene' },
  'telegraph.co.uk': { outletId: 'telegraph', outlet: 'The Telegraph' },
  'timeout.com': { outletId: 'timeout', outlet: 'Time Out New York' }
};

// Known mismatches from audit report
const MISMATCHES = [
  { show: 'and-juliet-2022', file: 'city-beat--brain-scott-lipton.json', expectedOutlet: 'cititour' },
  { show: 'and-juliet-2022', file: 'nydailynews--chris-jones.json', expectedOutlet: 'chicagotribune' },
  { show: 'buena-vista-social-club-2025', file: 'timeout--adam-feldman.json', expectedOutlet: 'newyorktheater' },
  { show: 'cabaret-2024', file: 'ew--emlyn-travis.json', expectedOutlet: 'amny' },
  { show: 'grey-house-2023', file: 'nydailynews--chris.json', expectedOutlet: 'chicagotribune' },
  { show: 'gutenberg-2023', file: 'nydailynews--chris.json', expectedOutlet: 'chicagotribune' },
  { show: 'hadestown-2019', file: 'ap--thom-geier.json', expectedOutlet: 'thewrap' },
  { show: 'hadestown-2019', file: 'theaterscenenet--victor-gluck.json', expectedOutlet: 'theaterscene' },
  { show: 'hamilton-2015', file: 'theaterscenenet--victor-gluck.json', expectedOutlet: 'theaterscene' },
  { show: 'harry-potter-2021', file: 'ap--diana-snyder.json', expectedOutlet: 'telegraph' },
  { show: 'illinoise-2024', file: 'theaterscenenet--victor-gluck.json', expectedOutlet: 'theaterscene' },
  { show: 'just-in-time-2025', file: 'nytimes--adam-feldman.json', expectedOutlet: 'timeout' },
  { show: 'liberation-2025', file: 'ew--emlyn-travis.json', expectedOutlet: 'thewrap' },
  { show: 'merrily-we-roll-along-2023', file: 'nydailynews--chris.json', expectedOutlet: 'chicagotribune' },
  { show: 'moulin-rouge-2019', file: 'ap--diane-snyder.json', expectedOutlet: 'telegraph' },
  { show: 'moulin-rouge-2019', file: 'ap--robert-hofler.json', expectedOutlet: 'thewrap' },
  { show: 'queen-versailles-2025', file: 'theaterscenenet--joseph-pisano.json', expectedOutlet: 'theaterscene' },
  { show: 'ragtime-2025', file: 'ew--shania-russell.json', expectedOutlet: 'amny' },
  { show: 'real-women-have-curves-2025', file: 'theaterscenenet--victor-gluck.json', expectedOutlet: 'theaterscene' },
  { show: 'six-2021', file: 'theaterscenenet--joseph-pisano.json', expectedOutlet: 'theaterscene' }
];

// Check for additional mismatches in remaining 3 files
function getOutletFromDomain(url) {
  if (!url) return null;
  try {
    const domain = new URL(url).hostname.replace('www.', '');
    return DOMAIN_TO_OUTLET[domain] || null;
  } catch {
    return null;
  }
}

function getCriticFromFilename(filename) {
  // Extract critic from filename like outlet--critic.json
  // Use split on '--' to handle outlets with hyphens (e.g., city-beat--critic.json)
  const parts = filename.replace('.json', '').split('--');
  return parts.length >= 2 ? parts.slice(1).join('--') : 'unknown';
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log(dryRun ? '=== DRY RUN ===' : '=== APPLYING FIXES ===');
  console.log('');

  const stats = {
    processed: 0,
    renamed: 0,
    skipped: 0,
    errors: []
  };

  for (const mismatch of MISMATCHES) {
    const { show, file, expectedOutlet } = mismatch;
    const oldPath = path.join(REVIEW_TEXTS_DIR, show, file);

    if (!fs.existsSync(oldPath)) {
      console.log(`SKIP: ${show}/${file} - file not found (may already be fixed)`);
      stats.skipped++;
      continue;
    }

    try {
      const data = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
      const critic = getCriticFromFilename(file);
      const newFilename = `${expectedOutlet}--${critic}.json`;
      const newPath = path.join(REVIEW_TEXTS_DIR, show, newFilename);

      // Get full outlet info
      const outletInfo = Object.values(DOMAIN_TO_OUTLET).find(o => o.outletId === expectedOutlet);

      if (!outletInfo) {
        console.log(`ERROR: ${show}/${file} - unknown outlet ${expectedOutlet}`);
        stats.errors.push({ show, file, error: `Unknown outlet: ${expectedOutlet}` });
        continue;
      }

      // Check if destination file already exists - merge if so
      if (fs.existsSync(newPath) && oldPath !== newPath) {
        console.log(`${dryRun ? 'WOULD ' : ''}MERGE: ${show}/${file} -> ${newFilename}`);

        if (!dryRun) {
          const existingData = JSON.parse(fs.readFileSync(newPath, 'utf8'));

          // Merge data: prefer existing but take fullText/scores from mismatched if better
          const merged = { ...existingData };

          // Take fullText from whichever is longer
          if (data.fullText && (!merged.fullText || data.fullText.length > merged.fullText.length)) {
            merged.fullText = data.fullText;
            merged.isFullReview = data.isFullReview;
            merged.textWordCount = data.textWordCount;
          }

          // Take llmScore if existing doesn't have one
          if (!merged.llmScore && data.llmScore) {
            merged.llmScore = data.llmScore;
            merged.llmMetadata = data.llmMetadata;
            merged.ensembleData = data.ensembleData;
          }

          // Merge excerpts
          if (!merged.dtliExcerpt && data.dtliExcerpt) merged.dtliExcerpt = data.dtliExcerpt;
          if (!merged.bwwExcerpt && data.bwwExcerpt) merged.bwwExcerpt = data.bwwExcerpt;
          if (!merged.showScoreExcerpt && data.showScoreExcerpt) merged.showScoreExcerpt = data.showScoreExcerpt;

          // Track merge
          merged.mergedFrom = merged.mergedFrom || [];
          merged.mergedFrom.push({ filename: file, mergedAt: new Date().toISOString() });

          // Write merged and delete old
          fs.writeFileSync(newPath, JSON.stringify(merged, null, 2));
          fs.unlinkSync(oldPath);
        }

        stats.merged = (stats.merged || 0) + 1;
        stats.processed++;
        continue;
      }

      console.log(`${dryRun ? 'WOULD ' : ''}RENAME: ${show}/${file} -> ${newFilename}`);

      if (!dryRun) {
        // Update data
        data.outletId = outletInfo.outletId;
        data.outlet = outletInfo.outlet;

        // Write to new location
        fs.writeFileSync(newPath, JSON.stringify(data, null, 2));

        // Remove old file
        fs.unlinkSync(oldPath);
      }

      stats.renamed++;
      stats.processed++;
    } catch (err) {
      console.log(`ERROR: ${show}/${file} - ${err.message}`);
      stats.errors.push({ show, file, error: err.message });
    }
  }

  console.log('');
  console.log('=== SUMMARY ===');
  console.log(`Processed: ${stats.processed}`);
  console.log(`Renamed: ${stats.renamed}`);
  console.log(`Merged: ${stats.merged || 0}`);
  console.log(`Skipped: ${stats.skipped}`);
  console.log(`Errors: ${stats.errors.length}`);

  if (stats.errors.length > 0) {
    console.log('\nErrors:');
    stats.errors.forEach(e => console.log(`  - ${e.show}/${e.file}: ${e.error}`));
  }
}

main();
