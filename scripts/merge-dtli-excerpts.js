#!/usr/bin/env node

/**
 * Merge DTLI excerpts into existing review files
 * Extracts excerpts from DTLI HTML archives and adds them as dtliExcerpt
 */

const fs = require('fs');
const path = require('path');

const dtliDir = 'data/aggregator-archive/dtli';
const reviewTextsDir = 'data/review-texts';

// Outlet normalization (same as extract-dtli-reviews.js)
const outletNormalization = {
  'new york times': 'nytimes',
  'vulture': 'vulture',
  'variety': 'variety',
  'hollywood reporter': 'hollywood-reporter',
  'the hollywood reporter': 'hollywood-reporter',
  'theatermania': 'theatermania',
  'deadline': 'deadline',
  'new york post': 'nypost',
  'ny post': 'nypost',
  'entertainment weekly': 'ew',
  'time out new york': 'timeout-ny',
  'time out': 'timeout-ny',
  'the guardian': 'guardian',
  'guardian': 'guardian',
  'daily beast': 'daily-beast',
  'the daily beast': 'daily-beast',
  'thewrap': 'thewrap',
  'the wrap': 'thewrap',
  'new yorker': 'new-yorker',
  'the new yorker': 'new-yorker',
  'new york daily news': 'nydn',
  'ny daily news': 'nydn',
  'associated press': 'ap',
  'ap': 'ap',
  'indiewire': 'indiewire',
  'broadway news': 'broadway-news',
  'broadway world': 'bww',
  'broadwayworld': 'bww',
  'ny1': 'ny1',
  'ny stage review': 'ny-stage-review',
  'stage and cinema': 'stage-and-cinema',
  'theatrely': 'theatrely',
  'cititour': 'cititour',
};

function normalizeOutletId(outlet) {
  const lower = outlet.toLowerCase().trim();
  return outletNormalization[lower] || lower.replace(/[^a-z0-9]+/g, '-');
}

function slugify(str) {
  if (!str) return 'unknown';
  return str.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

function extractDtliReviews(htmlContent, showId) {
  const reviews = [];
  const parts = htmlContent.split('<div class="review-item">');

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];

    // Extract outlet from aria-label
    const outletMatch = part.match(/aria-label="([^"]+)"/);
    if (!outletMatch) continue;
    const outletRaw = outletMatch[1];

    // Extract thumb
    const thumbMatch = part.match(/alt="(BigThumbs_[^"]+)"/);
    let thumb = null;
    if (thumbMatch) {
      const t = thumbMatch[1].toLowerCase();
      if (t.includes('up')) thumb = 'Up';
      else if (t.includes('down')) thumb = 'Down';
      else if (t.includes('meh') || t.includes('mid')) thumb = 'Meh';
    }

    // Extract critic name
    const criticMatch = part.match(/class="review-item-critic-name"[^>]*><a[^>]*>([^<]+)<br\s*\/?>\s*([^<]+)<\/a>/);
    let criticName = null;
    if (criticMatch) {
      criticName = `${criticMatch[1].trim()} ${criticMatch[2].trim()}`;
    }

    // Extract excerpt text
    const textMatch = part.match(/class="paragraph"[^>]*>([\s\S]*?)<\/p>/);
    let excerpt = null;
    if (textMatch) {
      excerpt = textMatch[1]
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

    if (!excerpt || excerpt.length < 30) continue;

    reviews.push({
      outletId: normalizeOutletId(outletRaw),
      criticName,
      excerpt,
      url,
      thumb
    });
  }

  return reviews;
}

// Main
const dtliFiles = fs.readdirSync(dtliDir).filter(f => f.endsWith('.html'));
let totalMatched = 0;
let totalAdded = 0;
let totalAlreadyHad = 0;

for (const file of dtliFiles) {
  const showId = file.replace('.html', '');
  const showDir = path.join(reviewTextsDir, showId);

  if (!fs.existsSync(showDir)) continue;

  const htmlContent = fs.readFileSync(path.join(dtliDir, file), 'utf8');
  const dtliReviews = extractDtliReviews(htmlContent, showId);

  let added = 0;
  for (const dtliReview of dtliReviews) {
    // Find matching review file
    const reviewFiles = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

    for (const reviewFile of reviewFiles) {
      const filePath = path.join(showDir, reviewFile);
      const review = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      // Match by outlet ID (file starts with outletId--)
      const fileOutletId = reviewFile.split('--')[0].toLowerCase();
      const dtliOutletId = dtliReview.outletId.toLowerCase();

      if (fileOutletId === dtliOutletId ||
          fileOutletId.includes(dtliOutletId) ||
          dtliOutletId.includes(fileOutletId)) {
        totalMatched++;

        if (!review.dtliExcerpt || review.dtliExcerpt.length < 20) {
          review.dtliExcerpt = dtliReview.excerpt;
          review.dtliThumb = dtliReview.thumb || review.dtliThumb;
          if (!review.url && dtliReview.url) review.url = dtliReview.url;

          fs.writeFileSync(filePath, JSON.stringify(review, null, 2));
          added++;
          totalAdded++;
        } else {
          totalAlreadyHad++;
        }
        break;
      }
    }
  }

  if (added > 0) {
    console.log(`${showId}: Added ${added} DTLI excerpts`);
  }
}

console.log('\n=== Summary ===');
console.log('DTLI reviews matched:', totalMatched);
console.log('Excerpts added:', totalAdded);
console.log('Already had excerpt:', totalAlreadyHad);
