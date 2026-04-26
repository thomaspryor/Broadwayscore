#!/usr/bin/env node

/**
 * Extract reviews from BWW Review Roundup pages and output JSON
 * Handles both new-style (BlogPosting entries) and old-style (articleBody text) formats
 */

const fs = require('fs');
const path = require('path');
const { normalizeOutlet: canonicalNormalizeOutlet, getOutletDisplayName, normalizePublishDate } = require('./lib/review-normalization');
const { parseArticleBodyReviews } = require('./lib/bww-roundup-parser');

const bwwDir = path.join(__dirname, '../data/aggregator-archive/bww-roundups');

// Fix 1: Load shows.json for production-year validation
const showsPath = path.join(__dirname, '../data/shows.json');
let showsBySlug = {};
try {
  const showsData = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  const showsList = showsData.shows || showsData;
  const showsArray = Array.isArray(showsList) ? showsList : Object.values(showsList);
  for (const s of showsArray) {
    if (s.id) showsBySlug[s.id] = s;
  }
} catch (e) {
  console.error('Warning: Could not load shows.json — skipping production-year validation');
}

// Fix 2: Load outlet registry for cross-reference validation
let validOutletIds = new Set();
try {
  const registry = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/outlet-registry.json'), 'utf8'));
  validOutletIds = new Set(Object.keys(registry.outlets));
  if (registry._aliasIndex) {
    for (const [alias] of Object.entries(registry._aliasIndex)) {
      if (alias !== '_note') validOutletIds.add(alias);
    }
  }
  for (const outlet of Object.values(registry.outlets)) {
    if (outlet.aliases) outlet.aliases.forEach(a => validOutletIds.add(a));
  }
} catch (e) {
  console.error('Warning: Could not load outlet-registry.json — skipping outlet cross-reference');
}

/**
 * Normalize outlet using the canonical module.
 * Returns { name, outletId } structure expected by this script.
 * Note: Tier info is no longer returned; use scoring config for tier lookups.
 */
function normalizeOutlet(outlet) {
  const outletId = canonicalNormalizeOutlet(outlet);
  const name = getOutletDisplayName(outletId);
  return { name, outletId };
}

function extractFromArticleBody(articleBody, showId, publishDate) {
  if (!articleBody) return [];

  const reviews = [];

  // Pattern parsing extracted to scripts/lib/bww-roundup-parser.js so the
  // first-name initial fix ("J. Kelly Nestruck") can be unit-tested.
  const parsedPairs = parseArticleBodyReviews(articleBody);

  for (const pair of parsedPairs) {
    const criticName = pair.criticName;
    const outletRaw = pair.outletRaw;
    let quote = pair.quote;

    if (quote.length > 500) {
      quote = quote.substring(0, 500);
      const lastPeriod = quote.lastIndexOf('.');
      if (lastPeriod > 200) {
        quote = quote.substring(0, lastPeriod + 1);
      }
      quote += '...';
    }

    const outlet = normalizeOutlet(outletRaw);

    reviews.push({
      showId,
      outletId: outlet.outletId,
      outlet: outlet.name,
      criticName,
      url: null,
      publishDate: normalizePublishDate(publishDate) || null,
      assignedScore: null,
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
      // Remove control characters that break JSON parsing
      const cleanedJson = scriptMatch[1].replace(/[\x00-\x1F\x7F]/g, ' ');
      const json = JSON.parse(cleanedJson);

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
          publishDate: normalizePublishDate(json.datePublished) || null,
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
      // Remove control characters that break JSON parsing
      const cleanedJson = jsonMatch[1].replace(/[\x00-\x1F\x7F]/g, ' ');
      const json = JSON.parse(cleanedJson);
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

/**
 * Fix 1: Check if a review's publish date is too early for the show's production.
 * Uses previewDate if available, otherwise openingDate. Threshold: 400 days
 * (generous to account for early preview coverage).
 */
function isWrongProduction(review, show) {
  if (!show || !review.publishDate) return false;
  const earliestDate = show.previewDate || show.openingDate;
  if (!earliestDate) return false;
  const pub = new Date(review.publishDate);
  const earliest = new Date(earliestDate);
  const daysBefore = (earliest - pub) / (1000 * 60 * 60 * 24);
  return daysBefore > 400;
}

/**
 * Fix 2: Check if an outlet ID is known in the registry.
 */
function isKnownOutlet(outletId) {
  if (validOutletIds.size === 0) return true; // Registry not loaded, skip check
  return validOutletIds.has(outletId);
}

// Main
const files = fs.readdirSync(bwwDir).filter(f => f.endsWith('.html'));

console.error('Extracting BWW Review Roundup reviews:\n');

const allReviews = [];
let wrongProdCount = 0;
let unknownOutletCount = 0;

for (const file of files.sort()) {
  const filePath = path.join(bwwDir, file);
  const showId = file.replace('.html', '');
  const show = showsBySlug[showId];

  const { reviews, method } = extractReviewsFromFile(filePath, showId);

  // Post-extraction validation
  for (const review of reviews) {
    // Fix 1: Flag reviews from wrong production
    if (isWrongProduction(review, show)) {
      review.wrongProduction = true;
      review.wrongProductionReason = `Published ${review.publishDate}, show opens ${show.previewDate || show.openingDate} — likely earlier production`;
      wrongProdCount++;
    }
    // Fix 2: Flag unknown outlets
    if (!isKnownOutlet(review.outletId)) {
      review._unknownOutlet = true;
      unknownOutletCount++;
    }
  }

  console.error(`${showId}: ${reviews.length} reviews (${method})`);
  allReviews.push(...reviews);
}

console.error(`\nTotal reviews extracted: ${allReviews.length}`);
if (wrongProdCount > 0) console.error(`  Wrong-production flagged: ${wrongProdCount}`);
if (unknownOutletCount > 0) console.error(`  Unknown outlets flagged: ${unknownOutletCount}`);

// Output JSON to stdout
console.log(JSON.stringify(allReviews, null, 2));
