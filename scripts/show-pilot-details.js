const data = require('../data/audit/validation/coverage-analysis.json');

// Show details for two-strangers and hells-kitchen
const shows = ['two-strangers-bway-2025', 'hells-kitchen-2024'];
for (const show of shows) {
  const s = data.byShow[show];
  if (s === undefined) {
    console.log(show + ': NOT FOUND');
    continue;
  }
  console.log('\n=== ' + show + ' ===');
  console.log('Total:', s.total, '| Full:', s.full, '| Partial:', s.partial, '| Missing:', s.none);
  console.log('\nReviews needing fetch:');
  s.reviews.filter(r => r.status !== 'full').forEach(r => {
    console.log('  -', r.outlet, '(' + r.critic + '):', r.status, '|', r.url || 'NO URL');
  });
}
