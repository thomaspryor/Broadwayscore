const fs = require('fs');
const path = require('path');

const reviewsDir = 'data/review-texts';
const shows = fs.readdirSync(reviewsDir).filter(f => fs.statSync(path.join(reviewsDir, f)).isDirectory());

let stats = {
  total: 0,
  fullText: 0,
  partialText: 0,
  noText: 0,
  tier1Missing: [],
  byShow: {}
};

const tier1Outlets = ['nytimes', 'vulture', 'variety', 'hollywood-reporter', 'thr', 'vult', 'nyt'];

for (const show of shows) {
  const showDir = path.join(reviewsDir, show);
  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));
  stats.byShow[show] = { total: 0, full: 0, partial: 0, none: 0, reviews: [] };

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));
      stats.total++;
      stats.byShow[show].total++;

      const textLen = data.fullText ? data.fullText.length : 0;
      const isFull = data.isFullReview === true || textLen > 1500;
      const isPartial = textLen > 200 && (isFull === false);

      const reviewInfo = {
        file,
        outlet: data.outlet,
        outletId: data.outletId,
        critic: data.criticName,
        url: data.url,
        textLen,
        status: isFull ? 'full' : isPartial ? 'partial' : 'missing'
      };

      stats.byShow[show].reviews.push(reviewInfo);

      if (isFull) {
        stats.fullText++;
        stats.byShow[show].full++;
      } else if (isPartial) {
        stats.partialText++;
        stats.byShow[show].partial++;
      } else {
        stats.noText++;
        stats.byShow[show].none++;
        const outletId = (data.outletId || '').toLowerCase();
        if (tier1Outlets.some(t => outletId.includes(t))) {
          stats.tier1Missing.push({ show, outlet: data.outlet, file, url: data.url });
        }
      }
    } catch (e) {
      console.error('Error parsing', path.join(showDir, file), e.message);
    }
  }
}

console.log('=== REVIEW TEXT COVERAGE STATS ===');
console.log('Total reviews:', stats.total);
console.log('Full text:', stats.fullText, '(' + Math.round(stats.fullText/stats.total*100) + '%)');
console.log('Partial text:', stats.partialText, '(' + Math.round(stats.partialText/stats.total*100) + '%)');
console.log('Missing text:', stats.noText, '(' + Math.round(stats.noText/stats.total*100) + '%)');
console.log('');
console.log('Tier 1 missing full text:', stats.tier1Missing.length);
stats.tier1Missing.slice(0, 20).forEach(m => console.log('  -', m.show + ':', m.outlet));
console.log('');
console.log('=== SHOWS BY COVERAGE ===');
const showStats = Object.entries(stats.byShow)
  .map(([show, s]) => ({ show, ...s, coverage: Math.round(s.full/s.total*100) }))
  .sort((a, b) => a.coverage - b.coverage);
showStats.slice(0, 10).forEach(s => console.log(s.show + ':', s.coverage + '% full (' + s.full + '/' + s.total + ')'));

// Save detailed stats for later use
fs.writeFileSync('data/audit/validation/coverage-analysis.json', JSON.stringify(stats, null, 2));
console.log('\nDetailed stats saved to data/audit/validation/coverage-analysis.json');
