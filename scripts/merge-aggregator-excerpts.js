#!/usr/bin/env node

/**
 * Merge Aggregator Excerpts
 *
 * Extracts excerpts from BWW and Show Score archives and merges them
 * into existing review files. This fixes the gap where archives exist
 * but excerpts weren't extracted during initial gathering.
 */

const fs = require('fs');
const path = require('path');
const { normalizeOutlet, normalizeCritic, areCriticsSimilar } = require('./lib/review-normalization');

const BWW_DIR = path.join(__dirname, '../data/aggregator-archive/bww-roundups');
const SS_DIR = path.join(__dirname, '../data/aggregator-archive/show-score');
const REVIEW_DIR = path.join(__dirname, '../data/review-texts');

// Stats tracking
const stats = {
  bww: { processed: 0, matched: 0, added: 0 },
  ss: { processed: 0, matched: 0, added: 0 }
};

/**
 * Extract reviews from BWW Review Roundup HTML
 */
function extractBWWReviews(html, showId) {
  const reviews = [];

  // Try JSON-LD articleBody first
  const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (jsonLdMatch) {
    try {
      const cleanedJson = jsonLdMatch[1].replace(/[\x00-\x1F\x7F]/g, ' ');
      const json = JSON.parse(cleanedJson);
      const articleBody = json.articleBody || '';

      if (articleBody) {
        // Pattern: "Critic Name, Outlet:" followed by review text
        const pattern = /([A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-zA-Z'-]+),\s+([A-Za-z][A-Za-z\s&'.\-]+):\s*([^]+?)(?=(?:[A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-zA-Z'-]+,\s+[A-Za-z])|Photo Credit:|$)/g;

        let match;
        while ((match = pattern.exec(articleBody)) !== null) {
          const criticName = match[1].trim();
          const outletRaw = match[2].trim();
          let excerpt = match[3].trim();

          // Clean up excerpt
          if (excerpt.length > 500) {
            excerpt = excerpt.substring(0, 500);
            const lastPeriod = excerpt.lastIndexOf('.');
            if (lastPeriod > 200) {
              excerpt = excerpt.substring(0, lastPeriod + 1);
            }
          }

          // Skip invalid entries
          if (outletRaw.length < 2 || outletRaw.length > 60) continue;
          if (/^(In|The|A|An|On|At|For|With|And|But|Or|If|So|As|By)$/i.test(outletRaw)) continue;
          // Lowered minimum to 20 chars - some valid excerpts are short when critics from same outlet appear consecutively
          if (excerpt.length < 20) continue;

          const outletId = normalizeOutlet(outletRaw);

          reviews.push({
            outletId,
            criticName,
            excerpt: excerpt.trim()
          });
        }
      }
    } catch (e) {
      // Skip JSON parse errors
    }
  }

  return reviews;
}

/**
 * Extract reviews from Show Score HTML
 */
function extractShowScoreReviews(html, showId) {
  const reviews = [];

  // Try JSON-LD structured data
  const jsonLdMatches = html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);

  for (const scriptMatch of jsonLdMatches) {
    try {
      const jsonContent = scriptMatch[1];
      const data = JSON.parse(jsonContent);

      if (data.review && Array.isArray(data.review)) {
        for (const review of data.review) {
          if (review.author && review.reviewBody) {
            const outletName = review.publisher?.name || '';
            const criticName = review.author?.name || '';
            const excerpt = review.reviewBody || '';

            if (outletName && excerpt.length > 50) {
              reviews.push({
                outletId: normalizeOutlet(outletName),
                criticName,
                excerpt: excerpt.substring(0, 500).trim()
              });
            }
          }
        }
      }
    } catch (e) {
      // Skip invalid JSON
    }
  }

  // Also try HTML parsing for review cards
  const cardPattern = /<div[^>]*class="[^"]*review[^"]*"[^>]*>[\s\S]*?<img[^>]*alt="([^"]+)"[\s\S]*?<a[^>]*href="\/member\/[^"]*">([^<]+)<\/a>[\s\S]*?<p[^>]*>([^<]+)/gi;

  let match;
  while ((match = cardPattern.exec(html)) !== null) {
    const outletName = match[1].trim();
    const criticName = match[2].trim();
    const excerpt = match[3].replace(/Read more.*$/i, '').trim();

    if (outletName && excerpt.length > 50) {
      const outletId = normalizeOutlet(outletName);
      // Avoid duplicates
      if (!reviews.some(r => r.outletId === outletId && r.criticName === criticName)) {
        reviews.push({ outletId, criticName, excerpt });
      }
    }
  }

  return reviews;
}

/**
 * Find matching review file for an extracted review
 */
function findMatchingReviewFile(showDir, extractedReview) {
  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

  for (const file of files) {
    try {
      const filePath = path.join(showDir, file);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      // Match by outlet ID
      const fileOutletId = normalizeOutlet(data.outletId || data.outlet || '');
      if (fileOutletId !== extractedReview.outletId) continue;

      // Match by critic name (flexible matching)
      const fileCritic = data.criticName || '';
      const extractedCritic = extractedReview.criticName || '';

      if (fileCritic && extractedCritic) {
        if (areCriticsSimilar(fileCritic, extractedCritic)) {
          return { filePath, data };
        }
      } else if (!fileCritic || !extractedCritic) {
        // If either is missing critic, match on outlet alone
        return { filePath, data };
      }
    } catch (e) {
      // Skip invalid files
    }
  }

  return null;
}

/**
 * Process BWW archives
 */
function processBWWArchives() {
  console.log('\n=== Processing BWW Review Roundups ===\n');

  const files = fs.readdirSync(BWW_DIR).filter(f => f.endsWith('.html'));

  for (const file of files) {
    const showId = file.replace('.html', '');
    const showDir = path.join(REVIEW_DIR, showId);

    if (!fs.existsSync(showDir)) {
      continue;
    }

    const html = fs.readFileSync(path.join(BWW_DIR, file), 'utf8');
    const extracted = extractBWWReviews(html, showId);

    let showAdded = 0;
    for (const review of extracted) {
      stats.bww.processed++;

      const match = findMatchingReviewFile(showDir, review);
      if (match) {
        stats.bww.matched++;

        // Only add if bwwExcerpt is missing or shorter
        if (!match.data.bwwExcerpt || match.data.bwwExcerpt.length < review.excerpt.length) {
          match.data.bwwExcerpt = review.excerpt;
          fs.writeFileSync(match.filePath, JSON.stringify(match.data, null, 2));
          stats.bww.added++;
          showAdded++;
        }
      }
    }

    if (showAdded > 0) {
      console.log(`  ${showId}: +${showAdded} BWW excerpts`);
    }
  }
}

/**
 * Process Show Score archives
 */
function processShowScoreArchives() {
  console.log('\n=== Processing Show Score Archives ===\n');

  const files = fs.readdirSync(SS_DIR).filter(f => f.endsWith('.html'));

  for (const file of files) {
    const showId = file.replace('.html', '');
    const showDir = path.join(REVIEW_DIR, showId);

    if (!fs.existsSync(showDir)) {
      continue;
    }

    const html = fs.readFileSync(path.join(SS_DIR, file), 'utf8');
    const extracted = extractShowScoreReviews(html, showId);

    let showAdded = 0;
    for (const review of extracted) {
      stats.ss.processed++;

      const match = findMatchingReviewFile(showDir, review);
      if (match) {
        stats.ss.matched++;

        // Only add if showScoreExcerpt is missing or shorter
        if (!match.data.showScoreExcerpt || match.data.showScoreExcerpt.length < review.excerpt.length) {
          match.data.showScoreExcerpt = review.excerpt;
          fs.writeFileSync(match.filePath, JSON.stringify(match.data, null, 2));
          stats.ss.added++;
          showAdded++;
        }
      }
    }

    if (showAdded > 0) {
      console.log(`  ${showId}: +${showAdded} Show Score excerpts`);
    }
  }
}

// Main
console.log('Merging aggregator excerpts into review files...');

processBWWArchives();
processShowScoreArchives();

console.log('\n=== Summary ===\n');
console.log('BWW Review Roundups:');
console.log(`  Extracted: ${stats.bww.processed}`);
console.log(`  Matched to files: ${stats.bww.matched}`);
console.log(`  New excerpts added: ${stats.bww.added}`);

console.log('\nShow Score:');
console.log(`  Extracted: ${stats.ss.processed}`);
console.log(`  Matched to files: ${stats.ss.matched}`);
console.log(`  New excerpts added: ${stats.ss.added}`);

console.log('\nDone!');
