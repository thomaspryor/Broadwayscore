#!/usr/bin/env node
/**
 * Fetch NYSR Scores from Live Pages
 *
 * Fetches the star ratings directly from NYSR URLs for reviews
 * that are missing verified scores.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const REVIEW_DIR = 'data/review-texts';

const stats = {
  total: 0,
  fetched: 0,
  updated: 0,
  failed: 0
};

/**
 * Fetch a URL and return the HTML
 */
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect
        fetchUrl(res.headers.location).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}

/**
 * Extract star rating from HTML
 */
function extractStars(html) {
  // Try og:description first
  const ogMatch = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i) ||
                  html.match(/<meta\s+content="([^"]+)"\s+property="og:description"/i);

  if (ogMatch) {
    const content = ogMatch[1];
    const starMatch = content.match(/^(★+☆*)/);
    if (starMatch) {
      return starMatch[1];
    }
  }

  // Try finding stars in the article body (after byline)
  // Pattern: "By Critic Name" followed by stars
  const bylineMatch = html.match(/By\s+[^<]+<\/[^>]+>\s*<[^>]*>\s*(★+☆*)/i);
  if (bylineMatch) {
    return bylineMatch[1];
  }

  // Try finding stars near the beginning of article content
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (articleMatch) {
    const starMatch = articleMatch[1].match(/(★+☆*)/);
    if (starMatch) {
      return starMatch[1];
    }
  }

  // Last resort: find any star pattern
  const anyMatch = html.match(/(★+☆*)/);
  if (anyMatch && anyMatch[1].length >= 3 && anyMatch[1].length <= 5) {
    return anyMatch[1];
  }

  return null;
}

/**
 * Convert stars to score
 */
function starsToScore(stars) {
  const filled = (stars.match(/★/g) || []).length;
  const total = stars.length;
  return {
    originalScore: `${filled}/${total} stars`,
    normalizedScore: Math.round((filled / total) * 100),
    stars
  };
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('Fetching NYSR scores from live pages...\n');

  // Find all NYSR reviews with removed scores
  const toFetch = [];
  const shows = fs.readdirSync(REVIEW_DIR).filter(f =>
    fs.statSync(path.join(REVIEW_DIR, f)).isDirectory()
  );

  for (const show of shows) {
    const showDir = path.join(REVIEW_DIR, show);
    const files = fs.readdirSync(showDir).filter(f =>
      f.includes('nysr--') && f.endsWith('.json')
    );

    for (const file of files) {
      const filePath = path.join(showDir, file);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      // Only process reviews with removed scores (unverified)
      if (!data.originalScore && data._removedScore && data.url) {
        toFetch.push({ filePath, data, show, file });
      }
    }
  }

  console.log(`Found ${toFetch.length} NYSR reviews to fetch\n`);
  stats.total = toFetch.length;

  for (let i = 0; i < toFetch.length; i++) {
    const { filePath, data, show, file } = toFetch[i];

    console.log(`[${i + 1}/${toFetch.length}] ${show}/${file}`);
    console.log(`  URL: ${data.url}`);

    try {
      const html = await fetchUrl(data.url);
      stats.fetched++;

      const stars = extractStars(html);

      if (stars) {
        const score = starsToScore(stars);
        console.log(`  ✓ Found: ${stars} → ${score.originalScore}`);

        // Update the review file
        data.originalScore = score.originalScore;
        data.originalScoreNormalized = score.normalizedScore;
        data.scoreSource = 'live-fetch';
        data._scoreFetchedAt = new Date().toISOString();

        // Prepend stars to fullText if not already there
        if (data.fullText && !data.fullText.trim().startsWith('★')) {
          data.fullText = stars + ' ' + data.fullText;
        }

        // Remove the _removedScore marker
        delete data._removedScore;
        delete data._removedScoreReason;
        delete data._removedAt;

        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        stats.updated++;
      } else {
        console.log(`  ✗ No stars found in page`);
        stats.failed++;
      }
    } catch (e) {
      console.log(`  ✗ Error: ${e.message}`);
      stats.failed++;
    }

    // Rate limit
    await sleep(1000);
  }

  console.log('\n' + '='.repeat(50));
  console.log('FETCH RESULTS');
  console.log('='.repeat(50));
  console.log(`Total: ${stats.total}`);
  console.log(`Fetched: ${stats.fetched}`);
  console.log(`Updated: ${stats.updated}`);
  console.log(`Failed: ${stats.failed}`);
}

main().catch(console.error);
