#!/usr/bin/env node

/**
 * Count reviews from BWW Review Roundup pages
 * Handles both new-style (BlogPosting entries) and old-style (articleBody text) formats
 */

const fs = require('fs');
const path = require('path');

const bwwDir = path.join(__dirname, '../data/aggregator-archive/bww-roundups');

function countReviewsInArticleBody(articleBody) {
  if (!articleBody) return 0;

  // Skip intro text - find where reviews start
  const reviewStart = articleBody.indexOf("Let's see what the critics had to say");
  const text = reviewStart > 0 ? articleBody.substring(reviewStart) : articleBody;

  // Pattern: "Name Name(s), Outlet Name:"
  // More permissive pattern that matches various formats
  const patterns = [
    // Standard: "First Last, Outlet:"
    /([A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+),\s+([A-Za-z][A-Za-z\s&'.]+):/g,
    // With middle initial: "First M. Last, Outlet:"
    /([A-Z][a-z]+\s+[A-Z]\.\s+[A-Z][a-z]+),\s+([A-Za-z][A-Za-z\s&'.]+):/g,
  ];

  const critics = new Set();

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const criticName = match[1].trim();
      const outlet = match[2].trim();

      // Filter out false positives
      if (outlet.length >= 2 && outlet.length <= 60 &&
          !outlet.includes('http') &&
          !outlet.match(/^(In|The|A|An|On|At|For|With|And|But|Or|If|So|As|By)$/i)) {
        critics.add(criticName.toLowerCase());
      }
    }
  }

  return critics.size;
}

function countBlogPostings(content) {
  return (content.match(/"@type":\s*"BlogPosting"/g) || []).length;
}

function extractArticleBody(content) {
  // Find the JSON-LD block and parse it properly
  const jsonMatch = content.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (jsonMatch) {
    try {
      const json = JSON.parse(jsonMatch[1]);
      return json.articleBody || null;
    } catch (e) {
      return null;
    }
  }
  return null;
}

function countReviewsInFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');

  // First try BlogPosting count (newer articles)
  const blogPostingCount = countBlogPostings(content);
  if (blogPostingCount > 0) {
    return { count: blogPostingCount, method: 'BlogPosting' };
  }

  // Fall back to articleBody parsing (older articles)
  const articleBody = extractArticleBody(content);
  if (articleBody) {
    const count = countReviewsInArticleBody(articleBody);
    return { count, method: 'articleBody' };
  }

  return { count: 0, method: 'none' };
}

// Main
const files = fs.readdirSync(bwwDir).filter(f => f.endsWith('.html'));

console.log('BWW Review Roundup counts:\n');
console.log('Show'.padEnd(40) + 'Reviews'.padStart(8) + '  Method');
console.log('-'.repeat(60));

const results = [];
for (const file of files.sort()) {
  const filePath = path.join(bwwDir, file);
  const { count, method } = countReviewsInFile(filePath);
  const showName = file.replace('.html', '');
  results.push({ showName, count, method });
  console.log(showName.padEnd(40) + count.toString().padStart(8) + '  ' + method);
}

console.log('\nTotal files:', files.length);
console.log('Total reviews:', results.reduce((sum, r) => sum + r.count, 0));

// Output JSON for use in comparison
const output = {};
for (const r of results) {
  output[r.showName] = r.count;
}
console.log('\nJSON output:');
console.log(JSON.stringify(output, null, 2));
