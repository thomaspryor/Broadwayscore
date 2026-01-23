#!/usr/bin/env node

/**
 * Fetch full review text from URLs for stubs that need it
 *
 * Usage:
 *   node scripts/fetch-review-texts.js [--dry-run] [--limit=N] [--show=showId]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const reviewTextsDir = path.join(__dirname, '../data/review-texts');

// Parse args
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitArg = args.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1]) : Infinity;
const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];

// Rate limiting - be polite to servers
const DELAY_MS = 2000;
const TIMEOUT_MS = 30000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;

    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      }
    };

    const req = protocol.get(url, options, (res) => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (redirectUrl.startsWith('/')) {
          const urlObj = new URL(url);
          redirectUrl = `${urlObj.protocol}//${urlObj.host}${redirectUrl}`;
        }
        fetchPage(redirectUrl).then(resolve).catch(reject);
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
    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}

// Extract article text from HTML - simple extraction
function extractArticleText(html, url) {
  // Remove scripts, styles, and other non-content
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '');

  // Try to find article content
  let articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (articleMatch) {
    text = articleMatch[1];
  } else {
    // Try common content containers
    const contentPatterns = [
      /<div[^>]*class="[^"]*article[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
      /<div[^>]*class="[^"]*story[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
      /<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
      /<main[^>]*>([\s\S]*?)<\/main>/i,
    ];

    for (const pattern of contentPatterns) {
      const match = html.match(pattern);
      if (match) {
        text = match[1];
        break;
      }
    }
  }

  // Try JSON-LD articleBody
  const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
  if (jsonLdMatch) {
    try {
      const jsonLd = JSON.parse(jsonLdMatch[1]);
      if (jsonLd.articleBody) {
        return cleanText(jsonLd.articleBody);
      }
      if (Array.isArray(jsonLd)) {
        for (const item of jsonLd) {
          if (item.articleBody) {
            return cleanText(item.articleBody);
          }
        }
      }
    } catch (e) {
      // Ignore JSON parse errors
    }
  }

  // Clean HTML tags and normalize whitespace
  return cleanText(text);
}

function cleanText(html) {
  return html
    .replace(/<[^>]+>/g, ' ')  // Remove HTML tags
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&rdquo;/g, '"')
    .replace(/&ldquo;/g, '"')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/\s+/g, ' ')      // Normalize whitespace
    .trim();
}

// Find all stubs that need full text and have URLs
function findStubsWithUrls() {
  const stubs = [];

  const shows = fs.readdirSync(reviewTextsDir).filter(f =>
    fs.statSync(path.join(reviewTextsDir, f)).isDirectory()
  );

  for (const show of shows) {
    if (showFilter && show !== showFilter) continue;

    const showDir = path.join(reviewTextsDir, show);
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

    for (const file of files) {
      const filePath = path.join(showDir, file);
      try {
        const review = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        if (review.needsFullText && review.url && review.url.startsWith('http')) {
          stubs.push({
            show,
            file,
            path: filePath,
            url: review.url,
            outlet: review.outlet
          });
        }
      } catch (e) {
        // Skip invalid JSON
      }
    }
  }

  return stubs;
}

async function main() {
  const stubs = findStubsWithUrls();

  console.log(`Found ${stubs.length} stubs with URLs that need full text\n`);
  if (dryRun) console.log('DRY RUN - no files will be modified\n');
  if (limit < Infinity) console.log(`Limiting to ${limit} fetches\n`);

  let fetched = 0;
  let errors = 0;
  let skipped = 0;

  // Group by domain to be extra polite
  const byDomain = {};
  for (const stub of stubs) {
    try {
      const domain = new URL(stub.url).hostname;
      if (!byDomain[domain]) byDomain[domain] = [];
      byDomain[domain].push(stub);
    } catch (e) {
      // Invalid URL
    }
  }

  // Process stubs
  for (const stub of stubs) {
    if (fetched >= limit) break;

    const shortPath = `${stub.show}/${stub.file}`;
    process.stdout.write(`[${fetched + 1}/${Math.min(stubs.length, limit)}] ${shortPath}: `);

    try {
      const html = await fetchPage(stub.url);
      const text = extractArticleText(html, stub.url);

      if (text.length < 100) {
        console.log(`SKIP (extracted text too short: ${text.length} chars)`);
        skipped++;
        continue;
      }

      // Truncate if too long (keep first 5000 chars)
      const fullText = text.length > 5000 ? text.substring(0, 5000) + '...' : text;

      if (!dryRun) {
        const review = JSON.parse(fs.readFileSync(stub.path, 'utf8'));
        review.fullText = fullText;
        review.needsFullText = false;
        review.fetchedAt = new Date().toISOString();
        fs.writeFileSync(stub.path, JSON.stringify(review, null, 2));
      }

      console.log(`OK (${fullText.length} chars)`);
      fetched++;

      await sleep(DELAY_MS);

    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      errors++;
    }
  }

  console.log('\n========================================');
  console.log(`Fetched: ${fetched}`);
  console.log(`Errors: ${errors}`);
  console.log(`Skipped (too short): ${skipped}`);
  console.log(`Remaining: ${stubs.length - fetched - errors - skipped}`);
}

main().catch(console.error);
