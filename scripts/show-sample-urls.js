const reviews = JSON.parse(require('fs').readFileSync('/tmp/scrapable-reviews.json', 'utf8'));
const byOutlet = {};
for (const r of reviews) {
  if (!byOutlet[r.outlet]) byOutlet[r.outlet] = [];
  byOutlet[r.outlet].push(r.url);
}
console.log('Sample URLs by outlet (need to verify):');
Object.entries(byOutlet).slice(0, 10).forEach(([outlet, urls]) => {
  console.log('\n' + outlet + ' (' + urls.length + ' reviews):');
  urls.slice(0, 2).forEach(u => console.log('  ' + u));
});
