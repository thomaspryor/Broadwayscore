#!/usr/bin/env node

/**
 * Extract reviews from BWW Review Roundup pages and output JSON
 * Handles both new-style (BlogPosting entries) and old-style (articleBody text) formats
 */

const fs = require('fs');
const path = require('path');
const { normalizeOutlet: canonicalNormalizeOutlet, getOutletDisplayName, normalizePublishDate } = require('./lib/review-normalization');

const bwwDir = path.join(__dirname, '../data/aggregator-archive/bww-roundups');

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
      publishDate: normalizePublishDate(publishDate) || null,
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
