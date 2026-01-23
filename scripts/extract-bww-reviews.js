#!/usr/bin/env node

/**
 * Extract reviews from BWW Review Roundup pages and output JSON
 * Handles both new-style (BlogPosting entries) and old-style (articleBody text) formats
 */

const fs = require('fs');
const path = require('path');

const bwwDir = path.join(__dirname, '../data/aggregator-archive/bww-roundups');

// Outlet name normalization and tier mapping
const outletNormalization = {
  'the new york times': { name: 'The New York Times', outletId: 'nytimes', tier: 1 },
  'new york times': { name: 'The New York Times', outletId: 'nytimes', tier: 1 },
  'nytimes': { name: 'The New York Times', outletId: 'nytimes', tier: 1 },
  'broadwayworld': { name: 'BroadwayWorld', outletId: 'broadwayworld', tier: 2 },
  'variety': { name: 'Variety', outletId: 'variety', tier: 1 },
  'the hollywood reporter': { name: 'The Hollywood Reporter', outletId: 'hollywood-reporter', tier: 1 },
  'hollywood reporter': { name: 'The Hollywood Reporter', outletId: 'hollywood-reporter', tier: 1 },
  'vulture': { name: 'Vulture', outletId: 'vulture', tier: 1 },
  'time out new york': { name: 'Time Out New York', outletId: 'timeout-ny', tier: 1 },
  'time out ny': { name: 'Time Out New York', outletId: 'timeout-ny', tier: 1 },
  'timeout': { name: 'Time Out New York', outletId: 'timeout-ny', tier: 1 },
  'deadline': { name: 'Deadline', outletId: 'deadline', tier: 1 },
  'the wall street journal': { name: 'The Wall Street Journal', outletId: 'wsj', tier: 1 },
  'wall street journal': { name: 'The Wall Street Journal', outletId: 'wsj', tier: 1 },
  'wsj': { name: 'The Wall Street Journal', outletId: 'wsj', tier: 1 },
  'new york post': { name: 'New York Post', outletId: 'nypost', tier: 2 },
  'ny post': { name: 'New York Post', outletId: 'nypost', tier: 2 },
  'the new york post': { name: 'New York Post', outletId: 'nypost', tier: 2 },
  'newsday': { name: 'Newsday', outletId: 'newsday', tier: 2 },
  'usa today': { name: 'USA Today', outletId: 'usa-today', tier: 2 },
  'associated press': { name: 'Associated Press', outletId: 'ap', tier: 1 },
  'ap': { name: 'Associated Press', outletId: 'ap', tier: 1 },
  'entertainment weekly': { name: 'Entertainment Weekly', outletId: 'ew', tier: 2 },
  'ew': { name: 'Entertainment Weekly', outletId: 'ew', tier: 2 },
  'the guardian': { name: 'The Guardian', outletId: 'guardian', tier: 1 },
  'guardian': { name: 'The Guardian', outletId: 'guardian', tier: 1 },
  'the telegraph': { name: 'The Telegraph', outletId: 'telegraph', tier: 2 },
  'telegraph': { name: 'The Telegraph', outletId: 'telegraph', tier: 2 },
  'theatermania': { name: 'TheaterMania', outletId: 'theatermania', tier: 2 },
  'new york daily news': { name: 'New York Daily News', outletId: 'ny-daily-news', tier: 2 },
  'daily news': { name: 'New York Daily News', outletId: 'ny-daily-news', tier: 2 },
  'the ny daily news': { name: 'New York Daily News', outletId: 'ny-daily-news', tier: 2 },
  'am new york': { name: 'amNewYork', outletId: 'amny', tier: 3 },
  'amnewyork': { name: 'amNewYork', outletId: 'amny', tier: 3 },
  'amny': { name: 'amNewYork', outletId: 'amny', tier: 3 },
  'the observer': { name: 'The Observer', outletId: 'observer', tier: 2 },
  'observer': { name: 'The Observer', outletId: 'observer', tier: 2 },
  'the wrap': { name: 'TheWrap', outletId: 'thewrap', tier: 2 },
  'thewrap': { name: 'TheWrap', outletId: 'thewrap', tier: 2 },
  'rolling stone': { name: 'Rolling Stone', outletId: 'rolling-stone', tier: 2 },
  'daily beast': { name: 'The Daily Beast', outletId: 'daily-beast', tier: 2 },
  'the daily beast': { name: 'The Daily Beast', outletId: 'daily-beast', tier: 2 },
  'new york stage review': { name: 'New York Stage Review', outletId: 'ny-stage-review', tier: 3 },
  'chicago tribune': { name: 'Chicago Tribune', outletId: 'chicago-tribune', tier: 2 },
  'nbc new york': { name: 'NBC New York', outletId: 'nbc-ny', tier: 3 },
  'huffington post': { name: 'HuffPost', outletId: 'huffpost', tier: 3 },
  'huffpost': { name: 'HuffPost', outletId: 'huffpost', tier: 3 },
  'dc theatre scene': { name: 'DC Theatre Scene', outletId: 'dc-theatre-scene', tier: 3 },
  'nj.com': { name: 'NJ.com', outletId: 'nj-com', tier: 3 },
  'the stage': { name: 'The Stage', outletId: 'the-stage', tier: 2 },
  'financial times': { name: 'Financial Times', outletId: 'financial-times', tier: 1 },
  'the new yorker': { name: 'The New Yorker', outletId: 'new-yorker', tier: 1 },
  'new yorker': { name: 'The New Yorker', outletId: 'new-yorker', tier: 1 },
};

function normalizeOutlet(outlet) {
  const key = outlet.toLowerCase().trim();
  return outletNormalization[key] || {
    name: outlet.trim(),
    outletId: outlet.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    tier: 3
  };
}

function extractFromArticleBody(articleBody, showId, publishDate) {
  if (!articleBody) return [];

  const reviews = [];

  // Find where reviews start
  const reviewStart = articleBody.indexOf("Let's see what the critics had to say");
  const text = reviewStart > 0 ? articleBody.substring(reviewStart) : articleBody;

  // Pattern to match "Critic Name, Outlet:" followed by review text
  const pattern = /([A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+),\s+([A-Za-z][A-Za-z\s&'.]+):\s*([^]+?)(?=(?:[A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+,\s+[A-Za-z][A-Za-z\s&'.]+:)|Photo Credit:|$)/g;

  let match;
  const seen = new Set();

  while ((match = pattern.exec(text)) !== null) {
    const criticName = match[1].trim();
    const outletRaw = match[2].trim();
    let quote = match[3].trim();

    // Clean up the quote - take first ~500 chars and try to end at sentence
    if (quote.length > 500) {
      quote = quote.substring(0, 500);
      const lastPeriod = quote.lastIndexOf('.');
      if (lastPeriod > 200) {
        quote = quote.substring(0, lastPeriod + 1);
      }
      quote += '...';
    }

    // Skip if we've already seen this critic
    const key = `${criticName.toLowerCase()}-${outletRaw.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Filter out false positives
    if (outletRaw.length < 2 || outletRaw.length > 60) continue;
    if (outletRaw.match(/^(In|The|A|An|On|At|For|With|And|But|Or|If|So|As|By)$/i)) continue;

    const outlet = normalizeOutlet(outletRaw);

    reviews.push({
      showId,
      outletId: outlet.outletId,
      outlet: outlet.name,
      criticName,
      url: null,
      publishDate: publishDate || null,
      assignedScore: null, // Will need to be filled in based on sentiment
      bucket: null,
      thumb: null,
      originalRating: null,
      pullQuote: quote.substring(0, 300) + (quote.length > 300 ? '...' : ''),
      source: 'bww-roundup'
    });
  }

  return reviews;
}

function extractFromBlogPostings(content, showId) {
  const reviews = [];

  // Find all script tags with JSON-LD
  const scriptMatches = content.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g);

  for (const scriptMatch of scriptMatches) {
    try {
      const json = JSON.parse(scriptMatch[1]);

      // Check if this is a BlogPosting (individual review)
      if (json['@type'] === 'BlogPosting' && json.author) {
        const authorName = Array.isArray(json.author) ? json.author[0]?.name : json.author?.name;
        if (!authorName) continue;

        // The author name in BlogPosting format is usually "Outlet - Critic Name"
        // or just the outlet name
        let outlet = authorName;
        let criticName = null;

        if (authorName.includes(' - ')) {
          const parts = authorName.split(' - ');
          outlet = parts[0].trim();
          criticName = parts[1]?.trim() || null;
        }

        const outletInfo = normalizeOutlet(outlet);
        const quote = json.articleBody || json.description || '';

        reviews.push({
          showId,
          outletId: outletInfo.outletId,
          outlet: outletInfo.name,
          criticName,
          url: json.url || null,
          publishDate: json.datePublished || null,
          assignedScore: null,
          bucket: null,
          thumb: null,
          originalRating: null,
          pullQuote: quote.substring(0, 300) + (quote.length > 300 ? '...' : ''),
          source: 'bww-roundup'
        });
      }
    } catch (e) {
      // Skip invalid JSON
    }
  }

  return reviews;
}

function extractReviewsFromFile(filePath, showId) {
  const content = fs.readFileSync(filePath, 'utf-8');

  // First try BlogPosting extraction (newer articles)
  const blogPostingReviews = extractFromBlogPostings(content, showId);
  if (blogPostingReviews.length > 0) {
    return { reviews: blogPostingReviews, method: 'BlogPosting' };
  }

  // Fall back to articleBody parsing (older articles)
  const jsonMatch = content.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (jsonMatch) {
    try {
      const json = JSON.parse(jsonMatch[1]);
      const articleBody = json.articleBody;
      const publishDate = json.datePublished;
      if (articleBody) {
        const reviews = extractFromArticleBody(articleBody, showId, publishDate);
        return { reviews, method: 'articleBody' };
      }
    } catch (e) {
      // Skip
    }
  }

  return { reviews: [], method: 'none' };
}

// Main
const files = fs.readdirSync(bwwDir).filter(f => f.endsWith('.html'));

console.error('Extracting BWW Review Roundup reviews:\n');

const allReviews = [];
for (const file of files.sort()) {
  const filePath = path.join(bwwDir, file);
  const showId = file.replace('.html', '');

  const { reviews, method } = extractReviewsFromFile(filePath, showId);

  console.error(`${showId}: ${reviews.length} reviews (${method})`);
  allReviews.push(...reviews);
}

console.error(`\nTotal reviews extracted: ${allReviews.length}`);

// Output JSON to stdout
console.log(JSON.stringify(allReviews, null, 2));
