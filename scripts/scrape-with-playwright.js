// This script outputs commands to be run via Playwright MCP
// Usage: node scripts/scrape-with-playwright.js [outlet] [limit]

const fs = require('fs');
const path = require('path');

const reviews = JSON.parse(fs.readFileSync('/tmp/reviews-needing-text.json', 'utf8'));

const args = process.argv.slice(2);
const outletFilter = args[0];
const limit = parseInt(args[1]) || 10;

// Filter reviews
let filtered = reviews.filter(r => r.url && r.len < 500);
if (outletFilter) {
  filtered = filtered.filter(r =>
    r.outlet.toLowerCase().includes(outletFilter.toLowerCase())
  );
}

filtered = filtered.slice(0, limit);

console.log(`Found ${filtered.length} reviews to scrape:\n`);

filtered.forEach((r, i) => {
  console.log(`${i + 1}. ${r.outlet} - ${r.show}`);
  console.log(`   URL: ${r.url}`);
  console.log(`   File: data/review-texts/${r.show}/${r.file}`);
  console.log('');
});
