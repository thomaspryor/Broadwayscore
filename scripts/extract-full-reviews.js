#!/usr/bin/env node

/**
 * Extract FULL review texts from BWW Review Roundup pages
 * Saves each review as a separate JSON file with all metadata
 *
 * Output structure:
 *   data/review-texts/{showId}/{outletId}--{critic-slug}.json
 *
 * Each file contains:
 *   - showId, outlet, outletId, criticName
 *   - url, publishDate
 *   - fullText (complete review text)
 *   - originalScore (if reviewer gave one)
 *   - assignedScore (null - to be filled by LLM)
 *   - source
 */

const fs = require('fs');
const path = require('path');

const bwwDir = path.join(__dirname, '../data/aggregator-archive/bww-roundups');
const outputDir = path.join(__dirname, '../data/review-texts');

// Outlet normalization
const outletNormalization = {
  'the new york times': { name: 'The New York Times', outletId: 'nytimes' },
  'new york times': { name: 'The New York Times', outletId: 'nytimes' },
  'broadwayworld': { name: 'BroadwayWorld', outletId: 'broadwayworld' },
  'variety': { name: 'Variety', outletId: 'variety' },
  'the hollywood reporter': { name: 'The Hollywood Reporter', outletId: 'hollywood-reporter' },
  'hollywood reporter': { name: 'The Hollywood Reporter', outletId: 'hollywood-reporter' },
  'vulture': { name: 'Vulture', outletId: 'vulture' },
  'time out new york': { name: 'Time Out New York', outletId: 'timeout-ny' },
  'time out ny': { name: 'Time Out New York', outletId: 'timeout-ny' },
  'deadline': { name: 'Deadline', outletId: 'deadline' },
  'the wall street journal': { name: 'The Wall Street Journal', outletId: 'wsj' },
  'wall street journal': { name: 'The Wall Street Journal', outletId: 'wsj' },
  'new york post': { name: 'New York Post', outletId: 'nypost' },
  'the new york post': { name: 'New York Post', outletId: 'nypost' },
  'newsday': { name: 'Newsday', outletId: 'newsday' },
  'usa today': { name: 'USA Today', outletId: 'usa-today' },
  'associated press': { name: 'Associated Press', outletId: 'ap' },
  'entertainment weekly': { name: 'Entertainment Weekly', outletId: 'ew' },
  'the guardian': { name: 'The Guardian', outletId: 'guardian' },
  'the telegraph': { name: 'The Telegraph', outletId: 'telegraph' },
  'theatermania': { name: 'TheaterMania', outletId: 'theatermania' },
  'new york daily news': { name: 'New York Daily News', outletId: 'ny-daily-news' },
  'the ny daily news': { name: 'New York Daily News', outletId: 'ny-daily-news' },
  'daily news': { name: 'New York Daily News', outletId: 'ny-daily-news' },
  'am new york': { name: 'amNewYork', outletId: 'amny' },
  'amnewyork': { name: 'amNewYork', outletId: 'amny' },
  'amny': { name: 'amNewYork', outletId: 'amny' },
  'the observer': { name: 'The Observer', outletId: 'observer' },
  'the wrap': { name: 'TheWrap', outletId: 'thewrap' },
  'thewrap': { name: 'TheWrap', outletId: 'thewrap' },
  'rolling stone': { name: 'Rolling Stone', outletId: 'rolling-stone' },
  'daily beast': { name: 'The Daily Beast', outletId: 'daily-beast' },
  'the daily beast': { name: 'The Daily Beast', outletId: 'daily-beast' },
  'new york stage review': { name: 'New York Stage Review', outletId: 'ny-stage-review' },
  'chicago tribune': { name: 'Chicago Tribune', outletId: 'chicago-tribune' },
  'nbc new york': { name: 'NBC New York', outletId: 'nbc-ny' },
  'huffington post': { name: 'HuffPost', outletId: 'huffpost' },
  'dc theatre scene': { name: 'DC Theatre Scene', outletId: 'dc-theatre-scene' },
  'nj.com': { name: 'NJ.com', outletId: 'nj-com' },
  'the stage': { name: 'The Stage', outletId: 'the-stage' },
  'financial times': { name: 'Financial Times', outletId: 'financial-times' },
  'the new yorker': { name: 'The New Yorker', outletId: 'new-yorker' },
  'new yorker': { name: 'The New Yorker', outletId: 'new-yorker' },
  'the washington post': { name: 'The Washington Post', outletId: 'washington-post' },
  'washington post': { name: 'The Washington Post', outletId: 'washington-post' },
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

function extractFromArticleBody(articleBody, showId, publishDate, sourceUrl) {
  if (!articleBody) return [];

  const reviews = [];

  // Find where reviews start
  const reviewStart = articleBody.indexOf("Let's see what the critics had to say");
  const text = reviewStart > 0 ? articleBody.substring(reviewStart) : articleBody;

  // Split by critic attribution pattern
  // Pattern: "Critic Name, Outlet:"
  const parts = text.split(/(?=[A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+,\s+[A-Za-z][A-Za-z\s&'.]+:)/);

  for (const part of parts) {
    // Match the critic/outlet at the start
    const match = part.match(/^([A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+),\s+([A-Za-z][A-Za-z\s&'.]+):\s*([\s\S]*)/);
    if (!match) continue;

    const criticName = match[1].trim();
    const outletRaw = match[2].trim();
    const fullText = match[3].trim();

    // Skip if outlet looks invalid
    if (outletRaw.length < 2 || outletRaw.length > 60) continue;
    if (outletRaw.match(/^(In|The|A|An|On|At|For|With|And|But|Or|If|So|As|By)$/i)) continue;
    if (fullText.length < 50) continue; // Skip very short entries

    const outlet = normalizeOutlet(outletRaw);

    reviews.push({
      showId,
      outletId: outlet.outletId,
      outlet: outlet.name,
      criticName,
      url: null, // BWW roundups don't have individual review URLs
      publishDate: publishDate || null,
      fullText,
      originalScore: null, // BWW doesn't include original scores
      assignedScore: null, // To be filled by LLM
      source: 'bww-roundup',
      sourceUrl
    });
  }

  return reviews;
}

function saveReview(review) {
  const showDir = path.join(outputDir, review.showId);
  if (!fs.existsSync(showDir)) {
    fs.mkdirSync(showDir, { recursive: true });
  }

  const filename = `${review.outletId}--${slugify(review.criticName)}.json`;
  const filepath = path.join(showDir, filename);

  fs.writeFileSync(filepath, JSON.stringify(review, null, 2));
  return filepath;
}

// Main
const files = fs.readdirSync(bwwDir).filter(f => f.endsWith('.html'));

console.log('Extracting full review texts from BWW Review Roundups:\n');

let totalReviews = 0;
let totalShows = 0;

for (const file of files.sort()) {
  const filePath = path.join(bwwDir, file);
  const showId = file.replace('.html', '');
  const content = fs.readFileSync(filePath, 'utf-8');

  // Extract JSON-LD
  const jsonMatch = content.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!jsonMatch) {
    console.log(`${showId}: No JSON-LD found`);
    continue;
  }

  let json;
  try {
    json = JSON.parse(jsonMatch[1]);
  } catch (e) {
    console.log(`${showId}: Invalid JSON-LD`);
    continue;
  }

  const articleBody = json.articleBody;
  const publishDate = json.datePublished;
  const sourceUrl = json.url;

  if (!articleBody) {
    console.log(`${showId}: No articleBody`);
    continue;
  }

  const reviews = extractFromArticleBody(articleBody, showId, publishDate, sourceUrl);

  if (reviews.length > 0) {
    totalShows++;
    for (const review of reviews) {
      saveReview(review);
      totalReviews++;
    }
    console.log(`${showId}: ${reviews.length} reviews saved`);
  } else {
    console.log(`${showId}: 0 reviews found`);
  }
}

console.log(`\n========================================`);
console.log(`Total: ${totalReviews} reviews from ${totalShows} shows`);
console.log(`Saved to: ${outputDir}/`);
console.log(`\nNext step: Run LLM scoring on each review file`);
