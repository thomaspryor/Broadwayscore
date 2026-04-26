#!/usr/bin/env node

/**
 * Count reviews from BWW Review Roundup pages
 * Handles both new-style (BlogPosting entries) and old-style (articleBody text) formats
 */

const fs = require('fs');
const path = require('path');
const { parseArticleBodyReviews } = require('./lib/bww-roundup-parser');

const bwwDir = path.join(__dirname, '../data/aggregator-archive/bww-roundups');

function countReviewsInArticleBody(articleBody) {
  if (!articleBody) return 0;
  const critics = new Set();
  for (const pair of parseArticleBodyReviews(articleBody)) {
    critics.add(pair.criticName.toLowerCase());
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
