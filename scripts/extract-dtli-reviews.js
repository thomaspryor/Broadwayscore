#!/usr/bin/env node

/**
 * Extract reviews from DTLI (Did They Like It) HTML pages
 * Includes: full text, URL, thumb (Up/Meh/Down), outlet, critic
 *
 * Output: data/review-texts/{showId}/{outletId}--{critic-slug}.json
 */

const fs = require('fs');
const path = require('path');
const { normalizeOutlet: canonicalNormalizeOutlet, getOutletDisplayName, slugify, normalizePublishDate } = require('./lib/review-normalization');

const dtliDir = path.join(__dirname, '../data/aggregator-archive/dtli');
const outputDir = path.join(__dirname, '../data/review-texts');
const AGGREGATOR_SUMMARY_PATH = path.join(__dirname, '../data/aggregator-summary.json');

/**
 * Load aggregator summary data
 */
function loadAggregatorSummary() {
  if (fs.existsSync(AGGREGATOR_SUMMARY_PATH)) {
    return JSON.parse(fs.readFileSync(AGGREGATOR_SUMMARY_PATH, 'utf8'));
  }
  return {
    _meta: {
      lastUpdated: null,
      description: 'Show-level summary data from all aggregators (DTLI, BWW, Show Score)'
    },
    dtli: {},
    bww: {},
    showScore: {}
  };
}

/**
 * Save aggregator summary data
 */
function saveAggregatorSummary(data) {
  data._meta.lastUpdated = new Date().toISOString();
  fs.writeFileSync(AGGREGATOR_SUMMARY_PATH, JSON.stringify(data, null, 2));
}

/**
 * Extract DTLI thumb counts from HTML
 */
function extractDTLIThumbCounts(content) {
  const thumbUpMatch = content.match(/thumbs-up\/thumb-(\d+)\.png/);
  const thumbMehMatch = content.match(/thumbs-meh\/thumb-(\d+)\.png/);
  const thumbDownMatch = content.match(/thumbs-down\/thumb-(\d+)\.png/);

  return {
    up: thumbUpMatch ? parseInt(thumbUpMatch[1]) : 0,
    meh: thumbMehMatch ? parseInt(thumbMehMatch[1]) : 0,
    down: thumbDownMatch ? parseInt(thumbDownMatch[1]) : 0
  };
}

/**
 * Extract DTLI URL from archived HTML header
 */
function extractDTLIUrl(content) {
  const urlMatch = content.match(/Source:\s*(https?:\/\/[^\n]+)/);
  return urlMatch ? urlMatch[1].trim() : null;
}

/**
 * Normalize outlet using the canonical module.
 * Returns { name, outletId } structure expected by this script.
 */
function normalizeOutlet(outlet) {
  const outletId = canonicalNormalizeOutlet(outlet);
  const name = getOutletDisplayName(outletId);
  return { name, outletId };
}

function parseThumb(thumbAlt) {
  if (!thumbAlt) return null;
  const alt = thumbAlt.toLowerCase();
  if (alt.includes('up')) return 'Up';
  if (alt.includes('down')) return 'Down';
  if (alt.includes('meh') || alt.includes('mid')) return 'Meh';
  return null;
}

/**
 * Clean HTML entities and tags from text
 */
function cleanText(text) {
  if (!text) return null;
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#8217;/g, "'")
    .replace(/&#8216;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/&#8211;/g, '–')
    .replace(/&#8212;/g, '—')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractReviewsFromDTLI(content, showId) {
  const reviews = [];

  // Split by review-item and parse each
  const parts = content.split('<div class="review-item">');

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];

    // Extract outlet - try aria-label first, then fall back to review_image div
    let outletRaw = null;
    const ariaLabelMatch = part.match(/aria-label="([^"]+)"/);
    if (ariaLabelMatch) {
      outletRaw = ariaLabelMatch[1];
    } else {
      // Fallback: look for <div class="review_image"><div>Outlet Name</div></div>
      const divOutletMatch = part.match(/<div class="review_image"><div>([^<]+)<\/div><\/div>/);
      if (divOutletMatch) {
        outletRaw = divOutletMatch[1].trim();
      }
    }

    // Skip if we can't identify the outlet
    if (!outletRaw) continue;

    // Extract thumb from image alt
    const thumbMatch = part.match(/alt="(BigThumbs_[^"]+)"/);
    const thumb = thumbMatch ? parseThumb(thumbMatch[1]) : null;

    // Extract critic name (First<br />Last or First<br/>Last)
    const criticMatch = part.match(/class="review-item-critic-name"[^>]*><a[^>]*>([^<]+)<br\s*\/?>\s*([^<]+)<\/a>/);
    let criticName = null;
    if (criticMatch) {
      criticName = `${criticMatch[1].trim()} ${criticMatch[2].trim()}`;
    }

    // Extract date
    const dateMatch = part.match(/class="review-item-date"[^>]*>([^<]+)<\/h3>/);
    const dateStr = dateMatch ? dateMatch[1].trim() : null;

    // Extract excerpt text - handle multiple formats:
    // 1. Direct text in <p class="paragraph">text</p>
    // 2. Nested content: <p class="paragraph"></p><div class="entry-content">text</div>
    let fullText = null;

    // First try: direct paragraph content
    const textMatch = part.match(/class="paragraph"[^>]*>([\s\S]*?)<\/p>/);
    if (textMatch) {
      fullText = cleanText(textMatch[1]);
    }

    // If paragraph is empty or short, try entry-content div
    if (!fullText || fullText.length < 30) {
      const entryContentMatch = part.match(/<div class="entry-content">([\s\S]*?)<\/div>/);
      if (entryContentMatch) {
        const entryText = cleanText(entryContentMatch[1]);
        if (entryText && entryText.length > (fullText?.length || 0)) {
          fullText = entryText;
        }
      }
    }

    // Also try: grab all text between review-item-date and review-item-button
    if (!fullText || fullText.length < 30) {
      const betweenMatch = part.match(/review-item-date[^>]*>[^<]*<\/h3>\s*([\s\S]*?)<a[^>]*class="button-pink review-item-button"/);
      if (betweenMatch) {
        const betweenText = cleanText(betweenMatch[1]);
        if (betweenText && betweenText.length > (fullText?.length || 0)) {
          fullText = betweenText;
        }
      }
    }

    // Extract URL
    const urlMatch = part.match(/href="([^"]+)"[^>]*class="button-pink review-item-button"/);
    const url = urlMatch ? urlMatch[1] : null;

    // Skip reviews with very short excerpts (likely just a title or placeholder)
    if (!fullText || fullText.length < 30) continue;

    const outlet = normalizeOutlet(outletRaw);

    reviews.push({
      showId,
      outletId: outlet.outletId,
      outlet: outlet.name,
      criticName,
      url,
      publishDate: normalizePublishDate(dateStr),
      dtliExcerpt: fullText,  // Store as excerpt since DTLI only provides excerpts
      fullText: null,          // Don't claim it's full text
      isFullReview: false,
      originalScore: null,
      assignedScore: null,
      dtliThumb: thumb,
      source: 'dtli'
    });
  }

  return reviews;
}

function saveReview(review, overwrite = false) {
  const showDir = path.join(outputDir, review.showId);
  if (!fs.existsSync(showDir)) {
    fs.mkdirSync(showDir, { recursive: true });
  }

  const filename = `${review.outletId}--${slugify(review.criticName)}.json`;
  const filepath = path.join(showDir, filename);

  // Check if file exists and merge data if so
  if (fs.existsSync(filepath) && !overwrite) {
    const existing = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    // Merge: preserve existing data while adding DTLI-specific fields
    review = {
      ...existing,
      // Always update DTLI-specific fields from this extraction
      dtliThumb: review.dtliThumb || existing.dtliThumb,
      dtliExcerpt: review.dtliExcerpt || existing.dtliExcerpt,
      // Preserve existing data
      fullText: existing.fullText || null,
      isFullReview: existing.isFullReview || false,
      showScoreExcerpt: existing.showScoreExcerpt || null,
      bwwExcerpt: existing.bwwExcerpt || null,
      bwwThumb: existing.bwwThumb || null,
      url: existing.url || review.url,
      publishDate: existing.publishDate || review.publishDate,
      originalScore: existing.originalScore || null,
      assignedScore: existing.assignedScore || null,
      llmScore: existing.llmScore || null,
      llmMetadata: existing.llmMetadata || null,
      ensembleData: existing.ensembleData || null,
      source: existing.source || review.source,
    };
  }

  fs.writeFileSync(filepath, JSON.stringify(review, null, 2));
  return filepath;
}

// Main
if (!fs.existsSync(dtliDir)) {
  console.error(`DTLI directory not found: ${dtliDir}`);
  process.exit(1);
}

const files = fs.readdirSync(dtliDir).filter(f => f.endsWith('.html'));

console.log('Extracting reviews from DTLI pages:\n');

let totalReviews = 0;
let totalShows = 0;
let totalUrls = 0;
let totalThumbsSaved = 0;

// Load aggregator summary for saving thumb counts
const aggregatorSummary = loadAggregatorSummary();

for (const file of files.sort()) {
  const filePath = path.join(dtliDir, file);
  const showId = file.replace('.html', '');
  const content = fs.readFileSync(filePath, 'utf-8');

  const reviews = extractReviewsFromDTLI(content, showId);

  // Extract and save thumb counts
  const thumbCounts = extractDTLIThumbCounts(content);
  const dtliUrl = extractDTLIUrl(content);

  if (thumbCounts.up > 0 || thumbCounts.meh > 0 || thumbCounts.down > 0) {
    aggregatorSummary.dtli[showId] = {
      up: thumbCounts.up,
      meh: thumbCounts.meh,
      down: thumbCounts.down,
      totalReviews: thumbCounts.up + thumbCounts.meh + thumbCounts.down,
      dtliUrl: dtliUrl,
      lastUpdated: new Date().toISOString()
    };
    totalThumbsSaved++;
  }

  if (reviews.length > 0) {
    totalShows++;
    let urlCount = 0;
    for (const review of reviews) {
      saveReview(review);
      totalReviews++;
      if (review.url) urlCount++;
    }
    totalUrls += urlCount;
    console.log(`${showId}: ${reviews.length} reviews (${urlCount} with URLs) [${thumbCounts.up}↑ ${thumbCounts.meh}↔ ${thumbCounts.down}↓]`);
  } else {
    console.log(`${showId}: 0 reviews found [${thumbCounts.up}↑ ${thumbCounts.meh}↔ ${thumbCounts.down}↓]`);
  }
}

// Save aggregator summary with all thumb counts
saveAggregatorSummary(aggregatorSummary);

console.log(`\n========================================`);
console.log(`Total: ${totalReviews} reviews from ${totalShows} shows`);
console.log(`Reviews with URLs: ${totalUrls}`);
console.log(`DTLI thumb counts saved: ${totalThumbsSaved} shows`);
console.log(`Saved to: ${outputDir}/`);
console.log(`Aggregator summary: ${AGGREGATOR_SUMMARY_PATH}`);
