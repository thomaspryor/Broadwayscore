#!/usr/bin/env node

/**
 * Merge Aggregator Excerpts
 *
 * Extracts excerpts from BWW and Show Score archives and merges them
 * into existing review files. This fixes the gap where archives exist
 * but excerpts weren't extracted during initial gathering.
 */

const { isReviewTextFile } = require('./lib/review-text-sidecars');
const fs = require('fs');
const path = require('path');
const { makeArchiveShowChecker } = require('./lib/archive-cache-guard');
const { loadShows } = require('./lib/show-matching');
const { normalizeOutlet, normalizeCritic, areCriticsSimilar } = require('./lib/review-normalization');
const { safeWriteReview } = require('./lib/review-write-guard');
const { parseArticleBodyReviews } = require('./lib/bww-roundup-parser');
const { hasHelpFlag } = require('./lib/cli-help.js');

// Archive files are named by show id, but the page inside can be another
// show's (BRO-3621): skip it rather than extract its reviews into this show.
const archiveShowChecker = makeArchiveShowChecker(loadShows());

const USAGE = `merge-aggregator-excerpts.js — Extract excerpts from BWW and Show Score archives and merge into review files.

Usage:
  node scripts/merge-aggregator-excerpts.js [options]
  node scripts/merge-aggregator-excerpts.js --audit-bww-digit-outlets [--bww-archive-dir=PATH]
  node scripts/merge-aggregator-excerpts.js --repair-bww-digit-outlets [--write] [--bww-archive-dir=PATH]
  node scripts/merge-aggregator-excerpts.js --help, -h    print this usage and exit

--audit-bww-digit-outlets  Read-only BRO-4371 sweep; emit JSON repair targets
                          without review text. Does not merge either source.
--repair-bww-digit-outlets Repair only source-matched corrupted fields, even when
                          the clean quote is shorter. Dry run unless --write.
--write                   Apply the digit-outlet repair through safeWriteReview.
--bww-archive-dir=PATH     Archive directory for the sweep (default: data/aggregator-archive/bww-roundups).
`;
// --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }

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
        for (const pair of parseArticleBodyReviews(articleBody)) {
          const criticName = pair.criticName;
          const outletRaw = pair.outletRaw;
          let excerpt = pair.quote;

          // Clean up excerpt
          if (excerpt.length > 500) {
            excerpt = excerpt.substring(0, 500);
            const lastPeriod = excerpt.lastIndexOf('.');
            if (lastPeriod > 200) {
              excerpt = excerpt.substring(0, lastPeriod + 1);
            }
          }

          // Lowered minimum to 20 chars — some valid excerpts are short when critics from same outlet appear consecutively
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
 * Find matching review file for an extracted review.
 *
 * BRO-2619: never pick by directory order. A same-critic match wins only when
 * it is the ONLY one; a match that leans on a missing byline (outlet alone)
 * likewise only when exactly one file is in play. Two candidates means we can't
 * tell which review the excerpt belongs to, so nothing is written.
 */
function findMatchingReviewFile(showDir, extractedReview) {
  const files = fs.readdirSync(showDir).filter(f => isReviewTextFile(f));
  const byCritic = [];
  const outletOnly = [];

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
        if (areCriticsSimilar(fileCritic, extractedCritic)) byCritic.push({ filePath, data });
      } else {
        // If either is missing critic, match on outlet alone
        outletOnly.push({ filePath, data });
      }
    } catch (e) {
      // Skip invalid files
    }
  }

  if (byCritic.length === 1) return byCritic[0];
  if (byCritic.length === 0 && outletOnly.length === 1) return outletOnly[0];
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
    const wrongShow = archiveShowChecker(html, showId);
    if (wrongShow) {
      console.log(`  [SKIP] ${showId}: archive is another show's page (${wrongShow.reason})`);
      continue;
    }
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
          if (safeWriteReview(match.filePath, match.data)?.wrote !== false) stats.bww.added++;
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
    const wrongShow = archiveShowChecker(html, showId);
    if (wrongShow) {
      console.log(`  [SKIP] ${showId}: archive is another show's page (${wrongShow.reason})`);
      continue;
    }
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
          if (safeWriteReview(match.filePath, match.data)?.wrote !== false) stats.ss.added++;
          showAdded++;
        }
      }
    }

    if (showAdded > 0) {
      console.log(`  ${showId}: +${showAdded} Show Score excerpts`);
    }
  }
}

module.exports = { findMatchingReviewFile };

function main() {
  const audit = process.argv.includes('--audit-bww-digit-outlets');
  const repair = process.argv.includes('--repair-bww-digit-outlets');
  const write = process.argv.includes('--write');
  if (audit && repair) throw new Error('Choose either --audit-bww-digit-outlets or --repair-bww-digit-outlets');
  if (write && !repair) throw new Error('--write requires --repair-bww-digit-outlets');
  if (audit || repair) {
    const { auditBwwDigitOutlets, repairBwwDigitOutlets } = require('./lib/bww-digit-outlet-audit');
    const archiveArg = process.argv.find(arg => arg.startsWith('--bww-archive-dir='));
    const report = (repair ? repairBwwDigitOutlets : auditBwwDigitOutlets)({
      archiveDir: archiveArg ? archiveArg.slice('--bww-archive-dir='.length) : BWW_DIR,
      reviewDir: REVIEW_DIR,
      checkArchive: archiveShowChecker,
      write,
    });
    console.log(JSON.stringify(report, null, 2));
    return;
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
}

if (require.main === module) main();
