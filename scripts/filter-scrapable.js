const fs = require('fs');

const reviews = JSON.parse(fs.readFileSync('/tmp/reviews-needing-text.json', 'utf8'));

// Accessible outlets (no hard paywall)
const accessibleOutlets = new Set([
  'Vulture',
  'Variety',
  'TheWrap',
  'The Wrap',
  'The Hollywood Reporter',
  'Deadline',
  'Theatrely',
  'THEATRELY',
  'New York Theatre Guide',
  'New York Stage Review',
  'Cititour',
  'BroadwayWorld',
  'TheaterMania',
  'Observer',
  'The Daily Beast',
  'IndieWire',
  'New York Theater',
  'Broadway News',
  'BROADWAY NEWS',
  'Culture Sauce',
  'Slant Magazine',
  'Slant',
  'amNewYork',
  'amNY',
  'One-Minute Critic',
  '1 Minute Critic',
  'Stage and Cinema',
  'Rolling Stone',
  'HuffPost',
  'Backstage',
  'Showbiz411',
  'Theater News Online',
  'Exeunt',
  'DC Theater Arts'
]);

// Paywalled outlets to skip
const paywalled = new Set([
  'The New York Times',
  'The Wall Street Journal',
  'The Washington Post',
  'WASHINGTON POST',
  'Washington Post',
  'Los Angeles Times',
  'LA Times',
  'La Times',
  'The LA Times',
  'Chicago Tribune'
]);

const scrapable = reviews.filter(r =>
  r.url &&
  accessibleOutlets.has(r.outlet) &&
  !paywalled.has(r.outlet)
);

console.log('Total reviews needing text:', reviews.length);
console.log('Scrapable (accessible outlets with URLs):', scrapable.length);

// Group by outlet
const byOutlet = {};
for (const r of scrapable) {
  byOutlet[r.outlet] = byOutlet[r.outlet] || [];
  byOutlet[r.outlet].push(r);
}

console.log('\nBy outlet:');
Object.entries(byOutlet)
  .sort((a, b) => b[1].length - a[1].length)
  .forEach(([outlet, list]) => console.log(`  ${outlet}: ${list.length}`));

fs.writeFileSync('/tmp/scrapable-reviews.json', JSON.stringify(scrapable, null, 2));
console.log('\nSaved to /tmp/scrapable-reviews.json');
