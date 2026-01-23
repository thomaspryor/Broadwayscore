#!/usr/bin/env node

/**
 * Fetch review texts from the Wayback Machine for URLs that returned 404
 * Uses the Wayback Machine API to find archived versions
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const DELAY_MS = 1500; // Be polite to archive.org
const TIMEOUT_MS = 30000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fetch(url, timeout = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, { timeout }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect
        fetch(res.headers.location, timeout).then(resolve).catch(reject);
        return;
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, data }));
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}

async function getWaybackUrl(originalUrl) {
  // Use Wayback Machine availability API
  const apiUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(originalUrl)}`;

  try {
    const response = await fetch(apiUrl);
    if (response.statusCode !== 200) return null;

    const data = JSON.parse(response.data);
    if (data.archived_snapshots && data.archived_snapshots.closest) {
      return data.archived_snapshots.closest.url;
    }
    return null;
  } catch (e) {
    return null;
  }
}

function extractArticleText(html) {
  // Remove script and style tags
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

  // Try to find article content
  const articleMatch = text.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (articleMatch) {
    text = articleMatch[1];
  } else {
    // Try common content containers
    const contentMatch = text.match(/<div[^>]*class="[^"]*(?:article|content|story|review)[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (contentMatch) {
      text = contentMatch[1];
    }
  }

  // Try JSON-LD articleBody
  const jsonLdMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  if (jsonLdMatch) {
    for (const match of jsonLdMatch) {
      try {
        const jsonContent = match.replace(/<\/?script[^>]*>/gi, '');
        const parsed = JSON.parse(jsonContent);
        const articleBody = parsed.articleBody || (parsed['@graph'] && parsed['@graph'].find(item => item.articleBody)?.articleBody);
        if (articleBody && articleBody.length > 200) {
          return articleBody.substring(0, 5000);
        }
      } catch (e) {}
    }
  }

  // Remove HTML tags and decode entities
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#8217;/g, "'");
  text = text.replace(/&#8216;/g, "'");
  text = text.replace(/&#8220;/g, '"');
  text = text.replace(/&#8221;/g, '"');
  text = text.replace(/&#8211;/g, '–');
  text = text.replace(/&#8212;/g, '—');
  text = text.replace(/\s+/g, ' ');
  text = text.trim();

  return text.substring(0, 5000);
}

async function processReview(filePath) {
  const review = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  // Skip if already has full text or no URL
  if (review.fullText && review.fullText.length > 100) return { status: 'skip', reason: 'has text' };
  if (!review.url) return { status: 'skip', reason: 'no url' };

  // Get Wayback Machine URL
  const waybackUrl = await getWaybackUrl(review.url);
  if (!waybackUrl) {
    return { status: 'error', reason: 'not in archive' };
  }

  // Fetch from Wayback
  try {
    const response = await fetch(waybackUrl);
    if (response.statusCode !== 200) {
      return { status: 'error', reason: `HTTP ${response.statusCode}` };
    }

    const text = extractArticleText(response.data);
    if (text.length < 100) {
      return { status: 'skip', reason: `too short: ${text.length} chars` };
    }

    // Update review file
    review.fullText = text;
    review.source = review.source || 'wayback';
    review.waybackUrl = waybackUrl;
    review.fetchedAt = new Date().toISOString();
    review.needsFullText = false;

    fs.writeFileSync(filePath, JSON.stringify(review, null, 2));
    return { status: 'ok', chars: text.length };
  } catch (e) {
    return { status: 'error', reason: e.message };
  }
}

async function main() {
  // Find all review files that need full text
  const shows = fs.readdirSync(REVIEW_TEXTS_DIR);
  const stubs = [];

  for (const show of shows) {
    const showDir = path.join(REVIEW_TEXTS_DIR, show);
    if (!fs.statSync(showDir).isDirectory()) continue;

    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const filePath = path.join(showDir, file);
      try {
        const review = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (review.url && (!review.fullText || review.fullText === null || review.needsFullText)) {
          stubs.push({ path: filePath, show, file, url: review.url });
        }
      } catch (e) {}
    }
  }

  console.log(`Found ${stubs.length} stubs that need full text\n`);

  let fetched = 0, errors = 0, skipped = 0, notInArchive = 0;

  for (let i = 0; i < stubs.length; i++) {
    const stub = stubs[i];
    const shortPath = `${stub.show}/${stub.file}`;

    process.stdout.write(`[${fetched + 1}/${stubs.length}] ${shortPath}: `);

    const result = await processReview(stub.path);

    if (result.status === 'ok') {
      console.log(`OK (${result.chars} chars)`);
      fetched++;
    } else if (result.status === 'skip') {
      console.log(`SKIP (${result.reason})`);
      skipped++;
    } else if (result.reason === 'not in archive') {
      console.log(`NOT IN ARCHIVE`);
      notInArchive++;
    } else {
      console.log(`ERROR: ${result.reason}`);
      errors++;
    }

    await sleep(DELAY_MS);
  }

  console.log('\n========================================');
  console.log(`Fetched: ${fetched}`);
  console.log(`Not in archive: ${notInArchive}`);
  console.log(`Errors: ${errors}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Remaining: ${stubs.length - fetched - errors - skipped - notInArchive}`);
}

main().catch(console.error);
