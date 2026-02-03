#!/usr/bin/env node
/**
 * Re-extract reviews from existing aggregator archives using fixed extraction code.
 *
 * This script processes:
 * 1. DTLI archives: Extracts reviews including new-style HTML format
 * 2. BWW archives: Uses robust BlogPosting + articleBody parsing
 * 3. Show Score: Fetches pagination API pages for additional reviews beyond initial 8
 *
 * Usage:
 *   node scripts/re-extract-aggregator-reviews.js [--source=dtli|bww|show-score|all] [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const {
  normalizeOutlet,
  normalizeCritic,
  normalizePublishDate,
  generateReviewFilename,
  getOutletDisplayName,
} = require('./lib/review-normalization');
const { classifyContentTier } = require('./lib/content-quality');

const dataDir = path.join(__dirname, '..', 'data');
const archiveDir = path.join(dataDir, 'aggregator-archive');
const reviewTextsDir = path.join(dataDir, 'review-texts');
const showsData = JSON.parse(fs.readFileSync(path.join(dataDir, 'shows.json'), 'utf-8'));

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const sourceFilter = (args.find(a => a.startsWith('--source=')) || '--source=all').split('=')[1];

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Reject outlet IDs that are clearly sentence fragments or junk
function isValidOutlet(outletId, outletRaw) {
  if (outletId.length > 35) return false;
  if (outletRaw.split(/\s+/).length > 5) return false;
  return true;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Build a URL→filepath index for each show to detect existing reviews under different filenames
const urlIndex = {};
function getUrlIndex(showId) {
  if (urlIndex[showId]) return urlIndex[showId];
  const showDir = path.join(reviewTextsDir, showId);
  const index = {};
  if (fs.existsSync(showDir)) {
    for (const f of fs.readdirSync(showDir).filter(f => f.endsWith('.json'))) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(showDir, f), 'utf-8'));
        if (data.url) index[data.url] = f;
      } catch (e) { /* skip */ }
    }
  }
  urlIndex[showId] = index;
  return index;
}

function writeReviewFile(review) {
  const showDir = path.join(reviewTextsDir, review.showId);
  if (!fs.existsSync(showDir)) fs.mkdirSync(showDir, { recursive: true });

  const filename = generateReviewFilename(review.outletId, review.criticName);
  let filepath = path.join(showDir, filename);

  // Check if this review URL already exists under a different filename
  if (review.url && !fs.existsSync(filepath)) {
    const idx = getUrlIndex(review.showId);
    const existingFile = idx[review.url];
    if (existingFile) {
      filepath = path.join(showDir, existingFile);
    }
  }

  // Don't overwrite existing review files — only create new ones
  if (fs.existsSync(filepath)) {
    // Check if we should merge new data into existing file
    try {
      const existing = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
      let updated = false;

      // Add DTLI excerpt if missing
      if (review.dtliExcerpt && !existing.dtliExcerpt) {
        existing.dtliExcerpt = review.dtliExcerpt;
        updated = true;
      }
      // Add DTLI thumb if missing
      if (review.dtliThumb && !existing.dtliThumb) {
        existing.dtliThumb = review.dtliThumb;
        updated = true;
      }
      // Add BWW excerpt if missing
      if (review.bwwExcerpt && !existing.bwwExcerpt) {
        existing.bwwExcerpt = review.bwwExcerpt;
        updated = true;
      }
      // Add URL if missing
      if (review.url && !existing.url) {
        existing.url = review.url;
        updated = true;
      }

      if (updated && !dryRun) {
        fs.writeFileSync(filepath, JSON.stringify(existing, null, 2));
      }
      return { action: updated ? 'merged' : 'exists', filename };
    } catch (e) {
      return { action: 'exists', filename };
    }
  }

  // Create new review file
  const reviewData = {
    showId: review.showId,
    outletId: review.outletId,
    outlet: review.outlet,
    criticName: review.criticName || 'Unknown',
    url: review.url || null,
    publishDate: review.publishDate || null,
    fullText: null,
    isFullReview: false,
    dtliExcerpt: review.dtliExcerpt || null,
    bwwExcerpt: review.bwwExcerpt || null,
    showScoreExcerpt: review.showScoreExcerpt || null,
    assignedScore: null,
    source: review.source,
    dtliThumb: review.dtliThumb || null,
  };

  // Classify content tier
  const tier = classifyContentTier(reviewData);
  reviewData.contentTier = tier;

  if (!dryRun) {
    fs.writeFileSync(filepath, JSON.stringify(reviewData, null, 2));
  }
  return { action: 'created', filename };
}

/**
 * DTLI: Re-extract from existing archives with new-style HTML support
 */
function reExtractDTLI() {
  const dtliDir = path.join(archiveDir, 'dtli');
  if (!fs.existsSync(dtliDir)) return { total: 0, created: 0, merged: 0 };

  const files = fs.readdirSync(dtliDir).filter(f => f.endsWith('.html'));
  let total = 0, created = 0, merged = 0;

  for (const file of files) {
    const showId = file.replace('.html', '');
    const html = fs.readFileSync(path.join(dtliDir, file), 'utf-8');

    // Extract the DTLI URL from archive header
    const urlMatch = html.match(/Archived URL: (.+)/);
    const dtliUrl = urlMatch ? urlMatch[1].trim() : `https://didtheylikeit.com/shows/${showId.replace(/-\d{4}$/, '')}-review/`;

    // Extract reviews using fixed regex (including new-style HTML)
    const reviewItemRegex = /<div class="review-item">([\s\S]*?)(?=<div class="review-item">|<\/section>|<div class="" id="modal-breakdown")/gi;

    let match;
    while ((match = reviewItemRegex.exec(html)) !== null) {
      const reviewHtml = match[1];

      // Extract outlet — supports both old-style (img alt) and new-style (div text)
      const outletMatch = reviewHtml.match(/class="review-item-attribution"[^>]*alt="([^"]+)"/i) ||
                          reviewHtml.match(/alt="([^"]+)"[^>]*class="review-item-attribution"/i) ||
                          reviewHtml.match(/class="review_image"><div>([^<]+)<\/div>/i);

      const thumbMatch = reviewHtml.match(/BigThumbs_(UP|MEH|DOWN)/i);
      // Extract critic name — prefer ?s= query param (always has full name)
      const criticSearchMatch = reviewHtml.match(/class="review-item-critic-name"[^>]*><a[^>]*href="[^"]*\?s=([^&"]+)/i);
      // Fallback: capture all text content including across <br> tags
      const criticTextMatch = reviewHtml.match(/class="review-item-critic-name"[^>]*>(?:<a[^>]*>)?([\s\S]*?)<\/(?:a|h2)>/i);
      const dateMatch = reviewHtml.match(/class="review-item-date"[^>]*>([^<]+)/i);
      const excerptMatch = reviewHtml.match(/<p class="paragraph">([^]*?)<\/p>/i);
      const urlMatch2 = reviewHtml.match(/href="(https?:\/\/[^"]+)"[^>]*class="[^"]*button-pink[^"]*review-item-button/i) ||
                        reviewHtml.match(/class="[^"]*button-pink[^"]*review-item-button[^"]*"[^>]*href="(https?:\/\/[^"]+)"/i) ||
                        reviewHtml.match(/href="(https?:\/\/[^"]+)"[^>]*>READ THE REVIEW/i);

      if (outletMatch && urlMatch2) {
        const outletRaw = outletMatch[1].trim();
        const outletId = normalizeOutlet(outletRaw);
        const outletName = getOutletDisplayName(outletId);
        const thumb = thumbMatch ? thumbMatch[1].toUpperCase() : null;
        let criticName = 'Unknown';
        if (criticSearchMatch) {
          criticName = decodeURIComponent(criticSearchMatch[1]).trim();
        } else if (criticTextMatch) {
          criticName = criticTextMatch[1].replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        }
        criticName = criticName.replace(/\s+/g, ' ').trim();
        const date = dateMatch ? dateMatch[1].trim() : null;
        let excerpt = excerptMatch ? excerptMatch[1].trim() : null;

        if (excerpt) {
          excerpt = excerpt.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#8217;/g, "'")
            .replace(/&#8220;/g, '\u201c').replace(/&#8221;/g, '\u201d').replace(/&#8212;/g, '\u2014')
            .replace(/\s+/g, ' ').trim();
        }

        const result = writeReviewFile({
          showId,
          outletId,
          outlet: outletName,
          criticName,
          url: urlMatch2[1],
          publishDate: normalizePublishDate(date) || null,
          dtliExcerpt: excerpt,
          dtliThumb: thumb === 'UP' ? 'Up' : thumb === 'DOWN' ? 'Down' : thumb === 'MEH' ? 'Meh' : null,
          source: 'dtli',
        });

        total++;
        if (result.action === 'created') created++;
        if (result.action === 'merged') merged++;
      }
    }
  }

  return { total, created, merged };
}

/**
 * BWW: Re-extract from existing archives with BlogPosting + articleBody parsing
 */
function reExtractBWW() {
  const bwwDir = path.join(archiveDir, 'bww-roundups');
  if (!fs.existsSync(bwwDir)) return { total: 0, created: 0, merged: 0 };

  const files = fs.readdirSync(bwwDir).filter(f => f.endsWith('.html'));
  let total = 0, created = 0, merged = 0;

  for (const file of files) {
    const showId = file.replace('.html', '');
    const html = fs.readFileSync(path.join(bwwDir, file), 'utf-8');

    // Method 1: Extract from BlogPosting JSON-LD entries
    let reviews = [];
    const scriptMatches = html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g);
    for (const scriptMatch of scriptMatches) {
      try {
        const cleanedJson = scriptMatch[1].replace(/[\x00-\x1F\x7F]/g, ' ');
        const json = JSON.parse(cleanedJson);

        if (json['@type'] === 'BlogPosting' && json.author) {
          const authorName = Array.isArray(json.author) ? json.author[0]?.name : json.author?.name;
          if (!authorName) continue;

          let outletRaw = authorName;
          let criticName = null;
          if (authorName.includes(' - ')) {
            const parts = authorName.split(' - ');
            outletRaw = parts[0].trim();
            criticName = parts[1]?.trim() || null;
          }

          const outletId = normalizeOutlet(outletRaw);
          const outletName = getOutletDisplayName(outletId);
          const quote = json.articleBody || json.description || '';

          reviews.push({
            showId,
            outletId,
            outlet: outletName,
            criticName,
            url: null,
            bwwExcerpt: quote.substring(0, 300) + (quote.length > 300 ? '...' : ''),
            source: 'bww-roundup',
          });
        }
      } catch (e) { /* skip */ }
    }

    // Method 2: Fall back to articleBody parsing
    if (reviews.length === 0) {
      const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
      if (jsonLdMatch) {
        try {
          const cleanedJson = jsonLdMatch[1].replace(/[\x00-\x1F\x7F]/g, ' ');
          const jsonLd = JSON.parse(cleanedJson);
          const articleBody = jsonLd.articleBody || '';
          const publishDate = jsonLd.datePublished || null;

          if (articleBody) {
            const reviewStart = articleBody.indexOf("Let's see what the critics had to say");
            const text = reviewStart > 0 ? articleBody.substring(reviewStart) : articleBody;

            const pattern = /([A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+),\s+([A-Za-z][A-Za-z\s&'.]+):\s*([^]+?)(?=(?:[A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+,\s+[A-Za-z][A-Za-z\s&'.]+:)|Photo Credit:|$)/g;

            let m;
            const seen = new Set();
            while ((m = pattern.exec(text)) !== null) {
              const criticName = m[1].trim();
              const outletRaw = m[2].trim();
              let quote = m[3].trim();

              if (quote.length > 500) {
                quote = quote.substring(0, 500);
                const lastPeriod = quote.lastIndexOf('.');
                if (lastPeriod > 200) quote = quote.substring(0, lastPeriod + 1);
                quote += '...';
              }

              const key = `${criticName.toLowerCase()}-${outletRaw.toLowerCase()}`;
              if (seen.has(key)) continue;
              seen.add(key);

              if (outletRaw.length < 2 || outletRaw.length > 60) continue;
              if (outletRaw.match(/^(In|The|A|An|On|At|For|With|And|But|Or|If|So|As|By)$/i)) continue;

              const outletId = normalizeOutlet(outletRaw);
              if (!isValidOutlet(outletId, outletRaw)) continue;
              const outletName = getOutletDisplayName(outletId);

              reviews.push({
                showId,
                outletId,
                outlet: outletName,
                criticName,
                url: null,
                publishDate: normalizePublishDate(publishDate) || null,
                bwwExcerpt: quote.substring(0, 300) + (quote.length > 300 ? '...' : ''),
                source: 'bww-roundup',
              });
            }
          }
        } catch (e) { /* skip */ }
      }
    }

    for (const review of reviews) {
      const result = writeReviewFile(review);
      total++;
      if (result.action === 'created') created++;
      if (result.action === 'merged') merged++;
    }
  }

  return { total, created, merged };
}

/**
 * Show Score: Fetch pagination API pages for reviews beyond the initial 8
 */
async function reExtractShowScore() {
  const ssDir = path.join(archiveDir, 'show-score');
  if (!fs.existsSync(ssDir)) return { total: 0, created: 0, merged: 0 };

  const files = fs.readdirSync(ssDir).filter(f => f.endsWith('.html'));
  let total = 0, created = 0, merged = 0;

  for (const file of files) {
    const showId = file.replace('.html', '');
    const html = fs.readFileSync(path.join(ssDir, file), 'utf-8');

    // Parse pagination attributes
    const nextPagePathMatch = html.match(/data-next-page-path="([^"]+)"/);
    const totalCountMatch = html.match(/js-show-page-v2__critic-reviews[^>]*data-total-count="(\d+)"/);

    if (!nextPagePathMatch || !totalCountMatch) continue;

    const nextPagePath = nextPagePathMatch[1];
    const totalCount = parseInt(totalCountMatch[1]);

    if (totalCount <= 8) continue; // No pagination needed

    console.log(`  ${showId}: ${totalCount} total reviews, fetching pagination...`);

    // Also extract initial 8 reviews from the archive
    extractShowScoreFromHtml(html, showId).forEach(review => {
      const result = writeReviewFile(review);
      total++;
      if (result.action === 'created') created++;
      if (result.action === 'merged') merged++;
    });

    // Fetch additional pages
    const maxPages = Math.ceil(totalCount / 8) + 1;
    for (let page = 2; page <= maxPages; page++) {
      const paginationUrl = `https://www.show-score.com${nextPagePath}?page=${page}`;

      try {
        const responseBody = await fetchUrl(paginationUrl);
        if (!responseBody) break;

        let tileHtml;
        try {
          const parsed = JSON.parse(responseBody);
          tileHtml = parsed.html || '';
        } catch (e) {
          tileHtml = responseBody;
        }

        if (!tileHtml || tileHtml.length < 10) break;

        const reviews = extractShowScoreFromHtml(tileHtml, showId);
        for (const review of reviews) {
          const result = writeReviewFile(review);
          total++;
          if (result.action === 'created') created++;
          if (result.action === 'merged') merged++;
        }

        if (reviews.length === 0) break;
        await sleep(500);
      } catch (e) {
        console.log(`    Page ${page} error: ${e.message}`);
        break;
      }
    }
  }

  return { total, created, merged };
}

function extractShowScoreFromHtml(html, showId) {
  const reviews = [];

  const outletRegex = /alt="([^"]+)"/g;
  const criticRegex = /href="\/member\/[^"]*">([^<]+)<\/a>/g;
  const urlRegex = /href="(https?:\/\/[^"]+)"[^>]*>Read more/gi;
  const dateRegex = /review-tile-v2__date[^>]*>\s*([^<]+)/g;

  const outlets = [];
  const critics = [];
  const urls = [];
  const dates = [];
  let m;

  while ((m = outletRegex.exec(html)) !== null) {
    if (!m[1].includes('white-pixel') && !m[1].includes('user-avatar') && m[1].length > 2) {
      outlets.push(m[1]);
    }
  }
  while ((m = criticRegex.exec(html)) !== null) critics.push(m[1].trim());
  while ((m = urlRegex.exec(html)) !== null) urls.push(m[1]);
  while ((m = dateRegex.exec(html)) !== null) dates.push(m[1].trim());

  const count = Math.max(outlets.length, urls.length);
  for (let i = 0; i < count; i++) {
    const outletRaw = outlets[i] || 'Unknown';
    const outletId = normalizeOutlet(outletRaw);
    const outletName = getOutletDisplayName(outletId);
    const url = urls[i] || null;

    if (url) {
      reviews.push({
        showId,
        outlet: outletName,
        outletId,
        criticName: critics[i] || 'Unknown',
        url,
        publishDate: normalizePublishDate(dates[i]) || null,
        source: 'show-score',
      });
    }
  }

  return reviews;
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 15000 }, (res) => {
      if (res.statusCode === 200) {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      } else {
        resolve(null);
      }
    }).on('error', () => resolve(null));
  });
}

// Main
async function main() {
  console.log(`Re-extracting aggregator reviews${dryRun ? ' (DRY RUN)' : ''}...`);
  console.log(`Source filter: ${sourceFilter}\n`);

  const results = {};

  if (sourceFilter === 'all' || sourceFilter === 'dtli') {
    console.log('=== DTLI ===');
    results.dtli = reExtractDTLI();
    console.log(`  Total: ${results.dtli.total}, Created: ${results.dtli.created}, Merged: ${results.dtli.merged}\n`);
  }

  if (sourceFilter === 'all' || sourceFilter === 'bww') {
    console.log('=== BWW ===');
    results.bww = reExtractBWW();
    console.log(`  Total: ${results.bww.total}, Created: ${results.bww.created}, Merged: ${results.bww.merged}\n`);
  }

  if (sourceFilter === 'all' || sourceFilter === 'show-score') {
    console.log('=== Show Score ===');
    results.showScore = await reExtractShowScore();
    console.log(`  Total: ${results.showScore.total}, Created: ${results.showScore.created}, Merged: ${results.showScore.merged}\n`);
  }

  // Summary
  console.log('=== SUMMARY ===');
  let totalCreated = 0, totalMerged = 0;
  for (const [source, data] of Object.entries(results)) {
    console.log(`  ${source}: ${data.created} new files, ${data.merged} merged`);
    totalCreated += data.created;
    totalMerged += data.merged;
  }
  console.log(`\n  TOTAL: ${totalCreated} new review files, ${totalMerged} merged`);

  if (dryRun) {
    console.log('\n  (DRY RUN - no files were written)');
  }
}

main().catch(console.error);
