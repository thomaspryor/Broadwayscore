#!/usr/bin/env node

/**
 * Extract reviews from DTLI (Did They Like It) HTML pages
 * Includes: full text, URL, thumb (Up/Meh/Down), outlet, critic
 *
 * Output: data/review-texts/{showId}/{outletId}--{critic-slug}.json
 */

const fs = require('fs');
const path = require('path');

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

// Outlet normalization
const outletNormalization = {
  'new york times': { name: 'The New York Times', outletId: 'nytimes' },
  'vulture': { name: 'Vulture', outletId: 'vulture' },
  'variety': { name: 'Variety', outletId: 'variety' },
  'hollywood reporter': { name: 'The Hollywood Reporter', outletId: 'hollywood-reporter' },
  'the hollywood reporter': { name: 'The Hollywood Reporter', outletId: 'hollywood-reporter' },
  'theatermania': { name: 'TheaterMania', outletId: 'theatermania' },
  'deadline': { name: 'Deadline', outletId: 'deadline' },
  'new york post': { name: 'New York Post', outletId: 'nypost' },
  'ny post': { name: 'New York Post', outletId: 'nypost' },
  'entertainment weekly': { name: 'Entertainment Weekly', outletId: 'ew' },
  'time out new york': { name: 'Time Out New York', outletId: 'timeout-ny' },
  'time out': { name: 'Time Out New York', outletId: 'timeout-ny' },
  'the guardian': { name: 'The Guardian', outletId: 'guardian' },
  'guardian': { name: 'The Guardian', outletId: 'guardian' },
  'wall street journal': { name: 'The Wall Street Journal', outletId: 'wsj' },
  'the wall street journal': { name: 'The Wall Street Journal', outletId: 'wsj' },
  'daily beast': { name: 'The Daily Beast', outletId: 'daily-beast' },
  'the daily beast': { name: 'The Daily Beast', outletId: 'daily-beast' },
  'the wrap': { name: 'TheWrap', outletId: 'thewrap' },
  'thewrap': { name: 'TheWrap', outletId: 'thewrap' },
  'associated press': { name: 'Associated Press', outletId: 'ap' },
  'ap': { name: 'Associated Press', outletId: 'ap' },
  'new yorker': { name: 'The New Yorker', outletId: 'new-yorker' },
  'the new yorker': { name: 'The New Yorker', outletId: 'new-yorker' },
  'observer': { name: 'The Observer', outletId: 'observer' },
  'the observer': { name: 'The Observer', outletId: 'observer' },
  'chicago tribune': { name: 'Chicago Tribune', outletId: 'chicago-tribune' },
  'usa today': { name: 'USA Today', outletId: 'usa-today' },
  'newsday': { name: 'Newsday', outletId: 'newsday' },
  'amnewyork': { name: 'amNewYork', outletId: 'amny' },
  'am new york': { name: 'amNewYork', outletId: 'amny' },
  'ny daily news': { name: 'New York Daily News', outletId: 'ny-daily-news' },
  'new york daily news': { name: 'New York Daily News', outletId: 'ny-daily-news' },
  'daily news': { name: 'New York Daily News', outletId: 'ny-daily-news' },
  'nbc new york': { name: 'NBC New York', outletId: 'nbc-ny' },
  'npr': { name: 'NPR', outletId: 'npr' },
  'ny stage review': { name: 'New York Stage Review', outletId: 'ny-stage-review' },
  'new york stage review': { name: 'New York Stage Review', outletId: 'ny-stage-review' },
  'rolling stone': { name: 'Rolling Stone', outletId: 'rolling-stone' },
  'financial times': { name: 'Financial Times', outletId: 'financial-times' },
  'the stage': { name: 'The Stage', outletId: 'the-stage' },
  'stage': { name: 'The Stage', outletId: 'the-stage' },
  'the telegraph': { name: 'The Telegraph', outletId: 'telegraph' },
  'telegraph': { name: 'The Telegraph', outletId: 'telegraph' },
  'london theatre': { name: 'London Theatre', outletId: 'london-theatre' },
  'whats on stage': { name: "What's On Stage", outletId: 'whats-on-stage' },
  "what's on stage": { name: "What's On Stage", outletId: 'whats-on-stage' },
  'broadwayworld': { name: 'BroadwayWorld', outletId: 'broadwayworld' },
  'broadway world': { name: 'BroadwayWorld', outletId: 'broadwayworld' },
  'vogue': { name: 'Vogue', outletId: 'vogue' },
  'town & country': { name: 'Town & Country', outletId: 'town-country' },
  'vanity fair': { name: 'Vanity Fair', outletId: 'vanity-fair' },
  'the arts desk': { name: 'The Arts Desk', outletId: 'arts-desk' },
};

function normalizeOutlet(outlet) {
  const key = outlet.toLowerCase().trim();
  return outletNormalization[key] || {
    name: outlet.trim(),
    outletId: outlet.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  };
}

function slugify(str) {
  return (str || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function parseThumb(thumbAlt) {
  if (!thumbAlt) return null;
  const alt = thumbAlt.toLowerCase();
  if (alt.includes('up')) return 'Up';
  if (alt.includes('down')) return 'Down';
  if (alt.includes('meh') || alt.includes('mid')) return 'Meh';
  return null;
}

function extractReviewsFromDTLI(content, showId) {
  const reviews = [];

  // Match each review-item block
  const reviewPattern = /<div class="review-item">([\s\S]*?)<\/div>\s*<\/div>\s*(?=<div class="review-item">|<div class="" id="modal|<\/section>|$)/g;

  // Simpler approach: split by review-item and parse each
  const parts = content.split('<div class="review-item">');

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];

    // Extract outlet from aria-label
    const outletMatch = part.match(/aria-label="([^"]+)"/);
    if (!outletMatch) continue;
    const outletRaw = outletMatch[1];

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

    // Extract full text from paragraph
    const textMatch = part.match(/class="paragraph"[^>]*>([\s\S]*?)<\/p>/);
    let fullText = null;
    if (textMatch) {
      // Clean HTML tags from text
      fullText = textMatch[1]
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#8217;/g, "'")
        .replace(/&#8220;/g, '"')
        .replace(/&#8221;/g, '"')
        .replace(/&#8211;/g, '–')
        .replace(/&#8212;/g, '—')
        .replace(/&nbsp;/g, ' ')
        .trim();
    }

    // Extract URL
    const urlMatch = part.match(/href="([^"]+)"[^>]*class="button-pink review-item-button"/);
    const url = urlMatch ? urlMatch[1] : null;

    if (!fullText || fullText.length < 50) continue;

    const outlet = normalizeOutlet(outletRaw);

    reviews.push({
      showId,
      outletId: outlet.outletId,
      outlet: outlet.name,
      criticName,
      url,
      publishDate: dateStr,
      fullText,
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
    // Merge: prefer DTLI data for url and thumb, keep existing fullText if longer
    review = {
      ...existing,
      ...review,
      fullText: (review.fullText && review.fullText.length > (existing.fullText || '').length)
        ? review.fullText
        : existing.fullText,
      url: review.url || existing.url,
      dtliThumb: review.dtliThumb || existing.dtliThumb,
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
