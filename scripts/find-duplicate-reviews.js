#!/usr/bin/env node

/**
 * Sprint 2.2: Find Duplicate Reviews Script
 *
 * Uses the normalization module to detect duplicate review files.
 * Groups reviews that normalize to the same key (outlet|critic).
 *
 * Output: data/audit/duplicates-found.json
 */

const fs = require('fs');
const path = require('path');
const {
  normalizeOutlet,
  normalizeCritic,
  generateReviewKey,
  areCriticsSimilar,
  levenshteinDistance
} = require('./lib/review-normalization');

const REVIEW_TEXTS_DIR = path.join(__dirname, '../data/review-texts');
const OUTPUT_DIR = path.join(__dirname, '../data/audit');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'duplicates-found.json');

function getShowDirectories() {
  return fs.readdirSync(REVIEW_TEXTS_DIR)
    .filter(f => {
      const fullPath = path.join(REVIEW_TEXTS_DIR, f);
      return fs.statSync(fullPath).isDirectory();
    })
    .sort();
}

function getReviewFiles(showDir) {
  const showPath = path.join(REVIEW_TEXTS_DIR, showDir);
  return fs.readdirSync(showPath)
    .filter(f => f.endsWith('.json') && f !== 'failed-fetches.json')
    .sort();
}

function parseFilename(filename) {
  const match = filename.match(/^(.+?)--(.+?)\.json$/);
  if (!match) {
    return { outlet: null, critic: null };
  }
  return { outlet: match[1], critic: match[2] };
}

function loadReview(showDir, file) {
  const filePath = path.join(REVIEW_TEXTS_DIR, showDir, file);
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    console.error(`Error reading ${filePath}: ${err.message}`);
    return null;
  }
}

function analyzeShowDuplicates(showDir) {
  const files = getReviewFiles(showDir);
  const reviewsByNormalizedKey = {};
  const reviewsBySimilarity = [];

  // First pass: group by exact normalized key
  for (const file of files) {
    const { outlet, critic } = parseFilename(file);
    if (!outlet || !critic) continue;

    const normalizedOutlet = normalizeOutlet(outlet);
    const normalizedCritic = normalizeCritic(critic);
    const key = `${normalizedOutlet}|${normalizedCritic}`;

    const review = loadReview(showDir, file);
    if (!review) continue;

    const reviewInfo = {
      file,
      outlet,
      critic,
      normalizedOutlet,
      normalizedCritic,
      hasFullText: !!(review.fullText && review.fullText.length > 100),
      fullTextLength: review.fullText ? review.fullText.length : 0,
      hasLlmScore: !!(review.llmScore && review.llmScore.score !== null),
      llmScore: review.llmScore ? review.llmScore.score : null,
      assignedScore: review.assignedScore,
      url: review.url,
      excerptCount: [
        review.dtliExcerpt,
        review.bwwExcerpt,
        review.showScoreExcerpt
      ].filter(Boolean).length,
      dtliExcerpt: review.dtliExcerpt,
      bwwExcerpt: review.bwwExcerpt,
      showScoreExcerpt: review.showScoreExcerpt,
      dtliThumb: review.dtliThumb,
      bwwThumb: review.bwwThumb
    };

    if (!reviewsByNormalizedKey[key]) {
      reviewsByNormalizedKey[key] = [];
    }
    reviewsByNormalizedKey[key].push(reviewInfo);
  }

  // Second pass: find similar critics within same outlet (fuzzy matching)
  const outletGroups = {};
  for (const file of files) {
    const { outlet, critic } = parseFilename(file);
    if (!outlet || !critic) continue;

    const normalizedOutlet = normalizeOutlet(outlet);
    if (!outletGroups[normalizedOutlet]) {
      outletGroups[normalizedOutlet] = [];
    }
    outletGroups[normalizedOutlet].push({ file, outlet, critic });
  }

  // Check for similar critic names within each outlet
  for (const [outletId, reviews] of Object.entries(outletGroups)) {
    if (reviews.length < 2) continue;

    for (let i = 0; i < reviews.length; i++) {
      for (let j = i + 1; j < reviews.length; j++) {
        const r1 = reviews[i];
        const r2 = reviews[j];

        const norm1 = normalizeCritic(r1.critic);
        const norm2 = normalizeCritic(r2.critic);

        // Skip if same normalized critic (already caught in first pass)
        if (norm1 === norm2) continue;

        // Check for partial name match or similar names
        const c1 = r1.critic.toLowerCase();
        const c2 = r2.critic.toLowerCase();

        let isSimilar = false;
        let reason = '';

        // Check partial name match (e.g., "jesse" vs "jesse-green")
        if (c1 !== c2) {
          if (c2.startsWith(c1 + '-') || c1.startsWith(c2 + '-')) {
            isSimilar = true;
            reason = 'partial-name';
          } else if (c2.startsWith(c1) && c1.length >= 4) {
            isSimilar = true;
            reason = 'prefix-match';
          } else if (c1.startsWith(c2) && c2.length >= 4) {
            isSimilar = true;
            reason = 'prefix-match';
          } else if (areCriticsSimilar(r1.critic, r2.critic) && norm1 !== norm2) {
            isSimilar = true;
            reason = 'fuzzy-match';
          }
        }

        if (isSimilar) {
          // Check if we already have this pair recorded
          const existingPair = reviewsBySimilarity.find(
            g => g.outlet === outletId &&
                 g.files.includes(r1.file) &&
                 g.files.includes(r2.file)
          );

          if (!existingPair) {
            reviewsBySimilarity.push({
              outlet: outletId,
              reason,
              critics: [r1.critic, r2.critic],
              normalizedCritics: [norm1, norm2],
              files: [r1.file, r2.file]
            });
          }
        }
      }
    }
  }

  return {
    exactDuplicates: reviewsByNormalizedKey,
    similarMatches: reviewsBySimilarity
  };
}

function main() {
  console.log('Finding duplicate reviews...\n');

  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const shows = getShowDirectories();
  console.log(`Analyzing ${shows.length} shows for duplicates...\n`);

  const result = {
    generatedAt: new Date().toISOString(),
    summary: {
      totalShows: shows.length,
      showsWithExactDuplicates: 0,
      showsWithSimilarMatches: 0,
      totalExactDuplicateGroups: 0,
      totalSimilarMatchGroups: 0,
      totalFilesAffected: 0
    },
    duplicateGroups: []
  };

  for (const showDir of shows) {
    const analysis = analyzeShowDuplicates(showDir);

    // Process exact duplicates (same normalized key)
    for (const [key, reviews] of Object.entries(analysis.exactDuplicates)) {
      if (reviews.length > 1) {
        result.summary.totalExactDuplicateGroups++;
        result.summary.totalFilesAffected += reviews.length;

        // Determine canonical file (prefer longer name, then has fullText, then has score)
        const sorted = reviews.slice().sort((a, b) => {
          // Prefer full critic name (longer)
          if (a.critic.length !== b.critic.length) {
            return b.critic.length - a.critic.length;
          }
          // Prefer has full text
          if (a.hasFullText !== b.hasFullText) {
            return b.hasFullText ? 1 : -1;
          }
          // Prefer has LLM score
          if (a.hasLlmScore !== b.hasLlmScore) {
            return b.hasLlmScore ? 1 : -1;
          }
          // Prefer more excerpts
          return b.excerptCount - a.excerptCount;
        });

        const canonicalFile = `${sorted[0].normalizedOutlet}--${sorted[0].normalizedCritic}.json`;

        result.duplicateGroups.push({
          showId: showDir,
          type: 'exact-normalized',
          key,
          canonicalFile,
          files: reviews.map(r => ({
            filename: r.file,
            outlet: r.outlet,
            critic: r.critic,
            hasFullText: r.hasFullText,
            fullTextLength: r.fullTextLength,
            hasLlmScore: r.hasLlmScore,
            llmScore: r.llmScore,
            assignedScore: r.assignedScore,
            excerptCount: r.excerptCount,
            url: r.url,
            dtliExcerpt: r.dtliExcerpt,
            bwwExcerpt: r.bwwExcerpt,
            showScoreExcerpt: r.showScoreExcerpt,
            dtliThumb: r.dtliThumb,
            bwwThumb: r.bwwThumb
          })),
          recommendation: reviews.length > 1 ? 'merge' : 'keep'
        });
      }
    }

    // Process similar matches (fuzzy)
    for (const match of analysis.similarMatches) {
      result.summary.totalSimilarMatchGroups++;
      result.summary.totalFilesAffected += match.files.length;

      // Load full review data for comparison
      const reviewData = match.files.map(file => {
        const review = loadReview(showDir, file);
        return {
          filename: file,
          critic: match.critics[match.files.indexOf(file)],
          normalizedCritic: match.normalizedCritics[match.files.indexOf(file)],
          hasFullText: review && review.fullText && review.fullText.length > 100,
          fullTextLength: review ? (review.fullText ? review.fullText.length : 0) : 0,
          hasLlmScore: review && review.llmScore && review.llmScore.score !== null,
          llmScore: review && review.llmScore ? review.llmScore.score : null,
          assignedScore: review ? review.assignedScore : null,
          excerptCount: review ? [
            review.dtliExcerpt,
            review.bwwExcerpt,
            review.showScoreExcerpt
          ].filter(Boolean).length : 0,
          url: review ? review.url : null
        };
      });

      // Determine canonical (prefer longer critic name)
      const sorted = reviewData.slice().sort((a, b) => {
        if (a.critic.length !== b.critic.length) {
          return b.critic.length - a.critic.length;
        }
        if (a.hasFullText !== b.hasFullText) {
          return b.hasFullText ? 1 : -1;
        }
        return b.excerptCount - a.excerptCount;
      });

      const { outlet: bestOutlet, critic: bestCritic } = parseFilename(sorted[0].filename);
      const canonicalFile = `${normalizeOutlet(bestOutlet)}--${normalizeCritic(sorted[0].critic)}.json`;

      result.duplicateGroups.push({
        showId: showDir,
        type: 'similar-critic',
        reason: match.reason,
        outlet: match.outlet,
        canonicalFile,
        files: reviewData,
        recommendation: 'review-manually'
      });
    }

    // Update show counts
    const showExactDups = Object.values(analysis.exactDuplicates).filter(r => r.length > 1).length;
    const showSimilarMatches = analysis.similarMatches.length;

    if (showExactDups > 0) result.summary.showsWithExactDuplicates++;
    if (showSimilarMatches > 0) result.summary.showsWithSimilarMatches++;
  }

  // Write output
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
  console.log(`Results saved to: ${OUTPUT_FILE}\n`);

  // Print summary
  console.log('=== DUPLICATE DETECTION SUMMARY ===\n');
  console.log(`Total shows analyzed: ${result.summary.totalShows}`);
  console.log(`Shows with exact duplicates: ${result.summary.showsWithExactDuplicates}`);
  console.log(`Shows with similar matches: ${result.summary.showsWithSimilarMatches}`);
  console.log(`Total exact duplicate groups: ${result.summary.totalExactDuplicateGroups}`);
  console.log(`Total similar match groups: ${result.summary.totalSimilarMatchGroups}`);
  console.log(`Total files affected: ${result.summary.totalFilesAffected}`);

  // Show sample duplicates
  const exactDups = result.duplicateGroups.filter(g => g.type === 'exact-normalized');
  if (exactDups.length > 0) {
    console.log('\n--- Exact Duplicates (same normalized key) ---');
    for (const dup of exactDups.slice(0, 5)) {
      console.log(`\n${dup.showId}: ${dup.key}`);
      console.log(`  Canonical: ${dup.canonicalFile}`);
      for (const f of dup.files) {
        console.log(`    - ${f.filename} (fullText: ${f.fullTextLength} chars, llmScore: ${f.llmScore}, excerpts: ${f.excerptCount})`);
      }
    }
    if (exactDups.length > 5) {
      console.log(`\n... and ${exactDups.length - 5} more exact duplicate groups`);
    }
  }

  const similarDups = result.duplicateGroups.filter(g => g.type === 'similar-critic');
  if (similarDups.length > 0) {
    console.log('\n--- Similar Critic Names (need manual review) ---');
    for (const dup of similarDups.slice(0, 5)) {
      console.log(`\n${dup.showId}: ${dup.outlet} [${dup.reason}]`);
      console.log(`  Canonical: ${dup.canonicalFile}`);
      for (const f of dup.files) {
        console.log(`    - ${f.filename} (critic: "${f.critic}", fullText: ${f.fullTextLength} chars)`);
      }
    }
    if (similarDups.length > 5) {
      console.log(`\n... and ${similarDups.length - 5} more similar match groups`);
    }
  }

  console.log('\n=== END SUMMARY ===');
}

main();
