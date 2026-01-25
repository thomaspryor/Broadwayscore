/**
 * Merge Show-Score URLs into Review Texts
 *
 * Updates review-texts files with verified URLs from Show-Score data.
 */

const fs = require('fs');
const path = require('path');

const REVIEW_TEXTS_DIR = 'data/review-texts';
const SHOW_SCORE_FILE = 'data/show-score.json';

// Normalize outlet names for matching
function normalizeOutlet(name) {
  return name.toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace('newyork', 'ny')
    .replace('magazine', '')
    .replace('thenew', '')
    .replace('the', '');
}

// Normalize critic names for matching
function normalizeCritic(name) {
  if (!name) return '';
  return name.toLowerCase()
    .replace(/[^a-z]/g, '')
    .replace('unknown', '');
}

function main() {
  console.log('=== Merging Show-Score URLs ===\n');

  // Load Show-Score data
  const showScore = JSON.parse(fs.readFileSync(SHOW_SCORE_FILE, 'utf8'));

  let updated = 0;
  let notFound = 0;
  let alreadyCorrect = 0;

  // Process each show in Show-Score
  for (const [showId, showData] of Object.entries(showScore.shows || {})) {
    if (!showData.criticReviews || showData.criticReviews.length === 0) continue;

    const reviewTextsDir = path.join(REVIEW_TEXTS_DIR, showId);
    if (!fs.existsSync(reviewTextsDir)) {
      console.log(`  ${showId}: No review-texts directory`);
      continue;
    }

    console.log(`\n${showId}:`);

    // Get all review files for this show
    const reviewFiles = fs.readdirSync(reviewTextsDir)
      .filter(f => f.endsWith('.json'))
      .map(f => ({
        filename: f,
        path: path.join(reviewTextsDir, f),
        data: JSON.parse(fs.readFileSync(path.join(reviewTextsDir, f), 'utf8'))
      }));

    // Match Show-Score reviews to review-texts files
    for (const ssReview of showData.criticReviews) {
      if (!ssReview.url) continue;

      const ssOutlet = normalizeOutlet(ssReview.outlet || '');
      const ssCritic = normalizeCritic(ssReview.author || '');

      // Find matching review file
      let match = null;
      let matchScore = 0;

      for (const reviewFile of reviewFiles) {
        const rtOutlet = normalizeOutlet(reviewFile.data.outlet || '');
        const rtCritic = normalizeCritic(reviewFile.data.criticName || '');

        // Score the match
        let score = 0;

        // Outlet match (required)
        if (ssOutlet.includes(rtOutlet) || rtOutlet.includes(ssOutlet)) {
          score += 10;
        } else if (ssOutlet.substring(0, 5) === rtOutlet.substring(0, 5)) {
          score += 5;
        } else {
          continue; // No outlet match, skip
        }

        // Critic match (bonus)
        if (ssCritic && rtCritic) {
          if (ssCritic === rtCritic) {
            score += 5;
          } else if (ssCritic.includes(rtCritic) || rtCritic.includes(ssCritic)) {
            score += 3;
          }
        }

        if (score > matchScore) {
          matchScore = score;
          match = reviewFile;
        }
      }

      if (match) {
        const currentUrl = match.data.url || '';
        const newUrl = ssReview.url;

        // Check if URLs are different
        if (currentUrl === newUrl) {
          alreadyCorrect++;
        } else if (match.data.urlVerified && match.data.fullText && match.data.textWordCount >= 300) {
          // Already verified and has text, skip
          alreadyCorrect++;
        } else {
          // Update the URL
          match.data.url = newUrl;
          match.data.urlSource = 'show-score';
          match.data.urlUpdatedAt = new Date().toISOString();

          // Also update excerpt if we have one
          if (ssReview.excerpt && !match.data.showScoreExcerpt) {
            match.data.showScoreExcerpt = ssReview.excerpt;
          }

          fs.writeFileSync(match.path, JSON.stringify(match.data, null, 2));
          console.log(`  Updated: ${match.filename}`);
          console.log(`    Old: ${currentUrl.substring(0, 60)}...`);
          console.log(`    New: ${newUrl.substring(0, 60)}...`);
          updated++;
        }
      } else {
        notFound++;
        console.log(`  No match: ${ssReview.outlet} - ${ssReview.author}`);
      }
    }
  }

  console.log('\n=== Summary ===');
  console.log(`URLs updated: ${updated}`);
  console.log(`Already correct: ${alreadyCorrect}`);
  console.log(`No matching file: ${notFound}`);
}

main();
