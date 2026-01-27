#!/usr/bin/env node
/**
 * Clean up review-text cruft:
 * 1. Old BWW extractions with wrong outlet mappings
 * 2. Duplicate files for same outlet/critic (keep the one with better data)
 * 3. UK/West End reviews in Broadway show directories
 *
 * Usage: node scripts/cleanup-review-cruft.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const reviewTextsDir = path.join(__dirname, '../data/review-texts');
const dryRun = process.argv.includes('--dry-run');

// Known wrong outlet mappings from old BWW extractions
// These files have wrong outletId due to the old buggy mapOutlet function
const WRONG_OUTLET_PATTERNS = [
  // "ew--" files that should be other outlets
  { pattern: /^ew--(?!.*(?:emlyn|christian-holub|dalton|shania|allison))/i, wrongOutlet: 'ew', description: 'EW file but critic not from EW' },
  // "nyp--" files that should be Washington Post
  { pattern: /^nyp--(?:peter-marks|naveen-kumar)/i, wrongOutlet: 'nyp', correctOutlet: 'wapo', description: 'Washington Post critic in NY Post file' },
];

// UK outlet patterns - should not be in Broadway show directories
const UK_OUTLET_PATTERNS = [
  /guardian-uk/i, /telegraph-uk/i, /times-uk/i, /independent-uk/i, /stage-uk/i,
  /london-evening-standard/i, /time-out-london/i, /london-theatre/i,
  /whatsonstage/i, /-uk--/i
];

// Outlets that commonly have wrong mappings
const OUTLET_CRITIC_CORRECTIONS = {
  // Critic -> correct outlet
  'joe-dziemianowicz': ['nytg', 'nydn'],  // NY Theatre Guide or Daily News
  'jonathan-mandell': ['nyt-theater'],     // NY Theater
  'david-finkle': ['nysr'],                // NY Stage Review
  'steven-suskin': ['nysr'],               // NY Stage Review
  'melissa-rose-bernardo': ['nysr'],       // NY Stage Review
  'gillian-russo': ['nytg'],               // NY Theatre Guide
  'frank-scheck': ['thr', 'nysr'],         // Hollywood Reporter or NY Stage Review
  'peter-marks': ['wapo'],                 // Washington Post
  'naveen-kumar': ['wapo', 'variety'],     // Washington Post or Variety
};

function findCruftFiles() {
  const cruftFiles = [];
  const showDirs = fs.readdirSync(reviewTextsDir)
    .filter(f => fs.statSync(path.join(reviewTextsDir, f)).isDirectory());

  for (const showId of showDirs) {
    const showDir = path.join(reviewTextsDir, showId);
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

    // Group files by critic name for duplicate detection
    const criticFiles = {};

    for (const file of files) {
      const filePath = path.join(showDir, file);

      // Check for UK outlets
      if (UK_OUTLET_PATTERNS.some(p => p.test(file))) {
        cruftFiles.push({
          path: filePath,
          reason: 'UK/West End outlet in Broadway show',
          file
        });
        continue;
      }

      // Parse critic name from filename
      const match = file.match(/^([^-]+)--(.+)\.json$/);
      if (!match) continue;

      const [, outletId, criticId] = match;

      // Track by critic for duplicate detection
      if (!criticFiles[criticId]) criticFiles[criticId] = [];
      criticFiles[criticId].push({ file, filePath, outletId });

      // Check for known wrong mappings
      const corrections = OUTLET_CRITIC_CORRECTIONS[criticId];
      if (corrections && !corrections.includes(outletId)) {
        // This might be a wrong mapping - check if correct file exists
        const hasCorrectFile = corrections.some(correctOutlet =>
          files.includes(`${correctOutlet}--${criticId}.json`)
        );

        if (hasCorrectFile) {
          cruftFiles.push({
            path: filePath,
            reason: `Wrong outlet mapping (${outletId} should be ${corrections.join(' or ')})`,
            file
          });
        }
      }
    }

    // Find duplicates (same critic, different outlets, but actually same review)
    for (const [criticId, filesForCritic] of Object.entries(criticFiles)) {
      if (filesForCritic.length > 1) {
        // Read all files and compare
        const fileData = filesForCritic.map(f => {
          try {
            const data = JSON.parse(fs.readFileSync(f.filePath, 'utf8'));
            return { ...f, data };
          } catch (e) {
            return { ...f, data: null };
          }
        }).filter(f => f.data);

        // Sort by quality (prefer: has URL, has fullText, has dtliThumb, has llmScore)
        fileData.sort((a, b) => {
          const scoreA = (a.data.url ? 4 : 0) + (a.data.fullText ? 3 : 0) +
                        (a.data.dtliThumb ? 2 : 0) + (a.data.llmScore ? 1 : 0);
          const scoreB = (b.data.url ? 4 : 0) + (b.data.fullText ? 3 : 0) +
                        (b.data.dtliThumb ? 2 : 0) + (b.data.llmScore ? 1 : 0);
          return scoreB - scoreA;
        });

        // Mark all but the best as duplicates
        for (let i = 1; i < fileData.length; i++) {
          cruftFiles.push({
            path: fileData[i].filePath,
            reason: `Duplicate of ${fileData[0].file} (lower quality)`,
            file: fileData[i].file
          });
        }
      }
    }
  }

  return cruftFiles;
}

function main() {
  console.log(`Scanning for review cruft... ${dryRun ? '(DRY RUN)' : ''}\n`);

  const cruftFiles = findCruftFiles();

  if (cruftFiles.length === 0) {
    console.log('No cruft files found!');
    return;
  }

  // Group by reason
  const byReason = {};
  for (const f of cruftFiles) {
    if (!byReason[f.reason]) byReason[f.reason] = [];
    byReason[f.reason].push(f);
  }

  console.log(`Found ${cruftFiles.length} cruft files:\n`);

  for (const [reason, files] of Object.entries(byReason)) {
    console.log(`=== ${reason} (${files.length} files) ===`);
    for (const f of files.slice(0, 10)) {
      console.log(`  ${f.path.replace(reviewTextsDir + '/', '')}`);
    }
    if (files.length > 10) {
      console.log(`  ... and ${files.length - 10} more`);
    }
    console.log('');
  }

  if (!dryRun) {
    console.log('Removing cruft files...');
    let removed = 0;
    for (const f of cruftFiles) {
      try {
        fs.unlinkSync(f.path);
        removed++;
      } catch (e) {
        console.log(`  Error removing ${f.file}: ${e.message}`);
      }
    }
    console.log(`\nRemoved ${removed} files.`);
  } else {
    console.log('Run without --dry-run to remove these files.');
  }
}

main();
