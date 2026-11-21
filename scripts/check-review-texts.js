const fs = require('fs');
const path = require('path');

const reviewTextsDir = 'data/review-texts';
const shows = fs.readdirSync(reviewTextsDir).filter(f => !f.startsWith('.'));

let withText = 0;
let shortOrEmpty = 0;
let needsScraping = [];

for (const show of shows) {
  const showDir = path.join(reviewTextsDir, show);
  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));
    const textLen = (data.fullText || '').length;
    if (textLen >= 500) {
      withText++;
    } else {
      shortOrEmpty++;
      needsScraping.push({
        show,
        file,
        url: data.url,
        outlet: data.outlet,
        len: textLen
      });
    }
  }
}

console.log('Reviews with full text (≥500 chars):', withText);
console.log('Reviews with short/empty text (<500 chars):', shortOrEmpty);

// Group by outlet to see which outlets need most work
const byOutlet = {};
for (const r of needsScraping) {
  byOutlet[r.outlet] = (byOutlet[r.outlet] || 0) + 1;
}

console.log('\nReviews needing text by outlet:');
Object.entries(byOutlet)
  .sort((a, b) => b[1] - a[1])
  .forEach(([outlet, count]) => console.log(`  ${outlet}: ${count}`));

// Save the list for scraping
fs.writeFileSync('/tmp/reviews-needing-text.json', JSON.stringify(needsScraping, null, 2));
console.log('\nSaved full list to /tmp/reviews-needing-text.json');
