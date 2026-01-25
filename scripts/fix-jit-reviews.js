const fs = require('fs');

// Read the reviews.json
const data = JSON.parse(fs.readFileSync('/Users/tompryor/Broadwayscore/data/reviews.json', 'utf8'));

// Get the list of valid file bases from remaining files
const validFiles = fs.readdirSync('/Users/tompryor/Broadwayscore/data/review-texts/just-in-time-2025/')
  .filter(f => f.endsWith('.json'))
  .map(f => {
    const match = f.match(/^(.+)--(.+)\.json$/);
    if (match) {
      return { fileOutlet: match[1], criticName: match[2].replace(/-/g, ' ') };
    }
    return null;
  })
  .filter(Boolean);

console.log('Valid files found:', validFiles.length);

// Create a map of outlet -> expected critic name (lowercase)
const expectedCritics = {};
for (const vf of validFiles) {
  expectedCritics[vf.fileOutlet] = vf.criticName.toLowerCase();
}
console.log('Expected critics:', expectedCritics);

// Map of outletId to file outlet name
const outletNormMap = {
  // Truncated/invalid - will be removed
  'THENEWYORK': null,
  'NEWYORKSTA': null,
  'NEWYORKPOS': null,
  'NEWYORKSUN': null,
  'NEWYORKTHE': null,
  'CHICAGOTRI': null,
  'ENTERTAINM': null,
  'CULTURESAU': null,
  'THEDAILYBE': null,
  // Valid mappings
  'NYT': 'nytimes',
  'NYTIMES': 'nytimes',
  'VARIETY': 'variety',
  'GUARDIAN': 'guardian',
  'EW': 'ew',
  'DEADLINE': 'deadline',
  'DAILYBEAST': 'daily-beast',
  'THEWRAP': 'thewrap',
  'VULTURE': 'vulture',
  'NYP': 'nypost',
  'NYPOST': 'nypost',
  'CHITRIB': 'chicago-tribune',
  'NYSUN': 'new-york-sun',
  'NYTG': 'new-york-theatre-guide',
  'CULTURESAUCE': 'culture-sauce',
  'THLY': 'theatrely',
  'NYTHEATER': 'new-york-theater',
  'NYTHTR': 'new-york-theater',
  'TIMEOUT': 'timeout',
  'TMAN': 'theatermania',
  'THEATERMANIA': 'theatermania',
  'CITITOUR': 'cititour',
  'THEATRELY': 'theatrely',
  'NYSR': 'ny-stage-review',
  'NYSTAGEREVIEW': 'ny-stage-review',
  'BWNEWS': 'broadway-news',
  'BROADWAYNEWS': 'broadway-news',
  'WASHPOST': 'washington-post'
};

// Separate just-in-time-2025 reviews from others
const otherReviews = data.reviews.filter(r => r.showId !== 'just-in-time-2025');
const jitReviews = data.reviews.filter(r => r.showId === 'just-in-time-2025');

console.log('Before: just-in-time-2025 reviews:', jitReviews.length);

const seenOutlets = new Set();
const keptReviews = jitReviews.filter(r => {
  const mappedOutlet = outletNormMap[r.outletId];
  
  // If outletId maps to null, it's a truncated invalid one - skip
  if (mappedOutlet === null) {
    console.log('Removing truncated:', r.outletId, r.criticName);
    return false;
  }
  
  // If we have a mapping, use it; otherwise skip (unknown outlet)
  if (mappedOutlet === undefined) {
    console.log('Removing unknown outlet:', r.outletId, r.criticName);
    return false;
  }
  
  const fileOutlet = mappedOutlet;
  
  // Check if this outlet has a corresponding file
  const expectedCritic = expectedCritics[fileOutlet];
  if (expectedCritic === undefined) {
    console.log('Removing no-file:', r.outletId, r.criticName, '-> would be', fileOutlet);
    return false;
  }
  
  // Check if the critic name matches (case-insensitive)
  const reviewCritic = r.criticName.toLowerCase();
  if (reviewCritic !== expectedCritic) {
    console.log('Removing wrong critic:', r.outletId, r.criticName, '- expected', expectedCritic);
    return false;
  }
  
  // De-duplicate by outlet (keep first occurrence)
  if (seenOutlets.has(fileOutlet)) {
    console.log('Removing duplicate:', r.outletId, r.criticName);
    return false;
  }
  seenOutlets.add(fileOutlet);
  return true;
});

console.log('After: just-in-time-2025 reviews:', keptReviews.length);
console.log('Kept outlets:', Array.from(seenOutlets).sort());

// Combine back
data.reviews = [...otherReviews, ...keptReviews];

// Write back
fs.writeFileSync('/Users/tompryor/Broadwayscore/data/reviews.json', JSON.stringify(data, null, 2));
console.log('Done! Total reviews now:', data.reviews.length);
