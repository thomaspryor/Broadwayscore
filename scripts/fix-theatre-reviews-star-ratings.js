#!/usr/bin/env node
/**
 * Fix theatre-reviews star rating misattribution
 *
 * theatre.reviews rates shows independently. Its star ratings were being
 * stamped as the listed outlet's originalScore, causing wrong scores.
 *
 * This script:
 * 1. Deletes review files with mangled critic names (roundup extraction artifacts)
 * 2. Strips theatre-reviews-star-rating data from remaining files
 * 3. Clears any auto-adjudication that was based on the wrong star rating
 */

const fs = require('fs');
const path = require('path');

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `fix-theatre-reviews-star-ratings.js — Fix theatre-reviews star rating misattribution.

Usage:
  node scripts/fix-theatre-reviews-star-ratings.js [options]
  node scripts/fix-theatre-reviews-star-ratings.js --help, -h    print this usage and exit
`;
const REVIEW_TEXTS_DIR = process.argv.find(a => a.startsWith('--dir='))
  ? process.argv.find(a => a.startsWith('--dir=')).slice(6)
  : path.join(__dirname, '..', 'data', 'review-texts');
const DRY_RUN = process.argv.includes('--dry-run');

// Mangled critic names from roundup extraction artifacts
const MANGLED_PATTERNS = [
  /^For /,
  /^Although /,
  /^Only /,
  /^Over$/,
  /^But for /,
  /^While for /,
  /^The Production/,
  /^Buy Tickets/i,
];

function isMangledCritic(name) {
  return MANGLED_PATTERNS.some(p => p.test(name));
}

function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const shows = fs.readdirSync(REVIEW_TEXTS_DIR)
    .filter(d => fs.statSync(path.join(REVIEW_TEXTS_DIR, d)).isDirectory());

  let deletedFiles = 0;
  let strippedScores = 0;
  let clearedAdjudications = 0;

  for (const show of shows) {
    const showDir = path.join(REVIEW_TEXTS_DIR, show);
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

    for (const file of files) {
      const filePath = path.join(showDir, file);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (e) {
        continue;
      }

      // Step 1: Delete mangled critic name files
      if (isMangledCritic(data.criticName || '')) {
        console.log(`DELETE ${show}/${file} (mangled critic: "${data.criticName}")`);
        if (!DRY_RUN) {
          fs.unlinkSync(filePath);
        }
        deletedFiles++;
        continue;
      }

      // Step 2: Strip theatre-reviews-star-rating data
      if (data.scoreSource === 'theatre-reviews-star-rating') {
        console.log(`STRIP ${show}/${file} (TR score: ${data.originalScore}, LLM: ${data.llmScore?.score || 'none'})`);

        delete data.originalScore;
        delete data.originalScoreNormalized;
        delete data.scoreSource;

        // Step 3: Clear auto-adjudication that was based on wrong star rating
        if (data.humanReviewNote && data.humanReviewNote.includes('originalScore')) {
          console.log(`  CLEAR adjudication (was: ${data.humanReviewScore}, restoring LLM: ${data.llmScore?.score})`);
          delete data.humanReviewScore;
          delete data.humanReviewNote;
          delete data.humanReviewPreviousScore;
          delete data.humanReviewAt;
          delete data.adjudicationAttempts;
          delete data.adjudicationHistory;
          clearedAdjudications++;
        }

        strippedScores++;
        if (!DRY_RUN) {
          fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
        }
      }
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Deleted mangled files: ${deletedFiles}`);
  console.log(`Stripped TR star ratings: ${strippedScores}`);
  console.log(`Cleared wrong adjudications: ${clearedAdjudications}`);
  if (DRY_RUN) console.log('(DRY RUN - no changes made)');
}

main();
