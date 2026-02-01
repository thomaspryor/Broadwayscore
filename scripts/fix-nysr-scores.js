#!/usr/bin/env node
/**
 * Fix NYSR Scores
 *
 * NYSR puts star ratings in the og:description meta tag, but our text scraper
 * missed them. This script extracts the correct ratings from archived HTML.
 *
 * Usage:
 *   node scripts/fix-nysr-scores.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');
const REVIEW_DIR = 'data/review-texts';
const ARCHIVES_DIR = 'data/archives/reviews';

const stats = {
  total: 0,
  alreadyCorrect: 0,
  fixed: 0,
  noArchive: 0,
  noStarsInArchive: 0,
  errors: 0
};

/**
 * Extract star rating from og:description in HTML
 */
function extractFromOgDescription(html) {
  // Look for og:description meta tag
  const ogMatch = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i) ||
                  html.match(/<meta\s+content="([^"]+)"\s+property="og:description"/i);

  if (ogMatch) {
    const content = ogMatch[1];
    // Check if it starts with stars
    const starMatch = content.match(/^(★+☆*)/);
    if (starMatch) {
      const stars = starMatch[1];
      const filled = (stars.match(/★/g) || []).length;
      const total = stars.length;
      return {
        originalScore: `${filled}/${total} stars`,
        normalizedScore: Math.round((filled / total) * 100),
        stars: stars,
        source: 'og-description'
      };
    }
  }

  return null;
}

/**
 * Extract star rating from beginning of article text in HTML
 */
function extractFromArticleStart(html) {
  // Look for stars at the start of article content
  // NYSR often has format: <article>★★★★☆ Review text...
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (articleMatch) {
    const articleContent = articleMatch[1];
    // Strip HTML tags and check for stars at start
    const textContent = articleContent.replace(/<[^>]+>/g, ' ').trim();
    const starMatch = textContent.match(/^(★+☆*)/);
    if (starMatch) {
      const stars = starMatch[1];
      const filled = (stars.match(/★/g) || []).length;
      const total = stars.length;
      return {
        originalScore: `${filled}/${total} stars`,
        normalizedScore: Math.round((filled / total) * 100),
        stars: stars,
        source: 'article-start'
      };
    }
  }

  return null;
}

/**
 * Find archived HTML for a review
 */
function findArchivedHtml(showId, filename) {
  const archiveDir = path.join(ARCHIVES_DIR, showId);
  if (!fs.existsSync(archiveDir)) return null;

  // Convert review filename to archive filename pattern
  // nysr--frank-scheck.json -> nysr--frank-scheck_*.html
  const baseFilename = filename.replace('.json', '');
  const files = fs.readdirSync(archiveDir);
  const htmlFile = files.find(f => f.startsWith(baseFilename) && f.endsWith('.html'));

  if (htmlFile) {
    return fs.readFileSync(path.join(archiveDir, htmlFile), 'utf8');
  }

  return null;
}

/**
 * Check if fullText starts with stars (already correct)
 */
function hasStarsAtStart(fullText) {
  if (!fullText) return false;
  return /^★/.test(fullText.trim());
}

async function main() {
  console.log('Fixing NYSR scores from archived HTML...\n');
  if (DRY_RUN) console.log('DRY RUN - no changes will be made\n');

  const fixed = [];
  const notFixed = [];

  // Find all NYSR reviews
  const shows = fs.readdirSync(REVIEW_DIR).filter(f =>
    fs.statSync(path.join(REVIEW_DIR, f)).isDirectory()
  );

  for (const show of shows) {
    const showDir = path.join(REVIEW_DIR, show);
    const files = fs.readdirSync(showDir).filter(f =>
      f.includes('nysr--') && f.endsWith('.json')
    );

    for (const file of files) {
      stats.total++;
      const filePath = path.join(showDir, file);

      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        // Check if already correct (stars at start of fullText)
        if (hasStarsAtStart(data.fullText)) {
          stats.alreadyCorrect++;
          continue;
        }

        // Need to fix - find archived HTML
        const html = findArchivedHtml(show, file);
        if (!html) {
          stats.noArchive++;
          notFixed.push({ file: `${show}/${file}`, reason: 'No archived HTML' });
          continue;
        }

        // Try to extract from og:description first, then article start
        let extracted = extractFromOgDescription(html);
        if (!extracted) {
          extracted = extractFromArticleStart(html);
        }

        if (!extracted) {
          stats.noStarsInArchive++;
          notFixed.push({ file: `${show}/${file}`, reason: 'No stars found in archive' });
          continue;
        }

        // Check if extracted score differs from current
        const oldScore = data.originalScore;
        const newScore = extracted.originalScore;

        console.log(`✓ ${show}/${file}`);
        console.log(`  Old: ${oldScore || 'null'} → New: ${newScore} (${extracted.stars})`);

        if (!DRY_RUN) {
          // Update the review file
          data.originalScore = extracted.originalScore;
          data.originalScoreNormalized = extracted.normalizedScore;
          data.scoreSource = extracted.source;
          data._scoreFixedFrom = oldScore;
          data._scoreFixedAt = new Date().toISOString();

          // Also prepend stars to fullText if missing
          if (data.fullText && !hasStarsAtStart(data.fullText)) {
            data.fullText = extracted.stars + ' ' + data.fullText;
          }

          fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        }

        stats.fixed++;
        fixed.push({
          file: `${show}/${file}`,
          critic: data.criticName,
          oldScore,
          newScore,
          stars: extracted.stars
        });

      } catch (e) {
        stats.errors++;
        console.error(`Error processing ${show}/${file}:`, e.message);
      }
    }
  }

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('NYSR SCORE FIX RESULTS');
  console.log('='.repeat(60));
  console.log(`\nTotal NYSR reviews: ${stats.total}`);
  console.log(`Already correct: ${stats.alreadyCorrect}`);
  console.log(`Fixed: ${stats.fixed}`);
  console.log(`No archived HTML: ${stats.noArchive}`);
  console.log(`No stars in archive: ${stats.noStarsInArchive}`);
  console.log(`Errors: ${stats.errors}`);

  if (notFixed.length > 0) {
    console.log('\nCould not fix:');
    notFixed.forEach(n => console.log(`  - ${n.file}: ${n.reason}`));
  }

  // Save report
  const report = {
    timestamp: new Date().toISOString(),
    dryRun: DRY_RUN,
    stats,
    fixed,
    notFixed
  };

  fs.writeFileSync('data/audit/nysr-score-fixes.json', JSON.stringify(report, null, 2));
  console.log('\n✓ Report saved to data/audit/nysr-score-fixes.json');
}

main().catch(console.error);
