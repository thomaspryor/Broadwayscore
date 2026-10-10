import { getAllShows } from '@/lib/data-core';
import { hasEnoughReviews } from '@/config/score-buckets';
import { getShowRanks } from '@/lib/data-show-ranks';
const all = getAllShows();
const bw = all.filter(s => s.category === 'broadway');
const bwScored = bw.filter(s => {
  const rc = s.criticScore?.reviewCount ?? 0;
  const t12 = (s.criticScore?.tier1Count ?? 0) + (s.criticScore?.tier2Count ?? 0);
  return hasEnoughReviews(rc, s.category, t12, false);
});
console.log('Total BW shows:', bw.length);
console.log('BW scored (all-time pool, curated=false):', bwScored.length);
const dda = bwScored.find(s => s.id === 'dog-day-afternoon-2026');
console.log('DDA score:', dda?.criticScore?.score);
const ranks = getShowRanks('dog-day-afternoon-2026', { format: 'all' });
console.log('DDA ranks:', JSON.stringify(ranks, null, 2));
// Score distribution
const scores = bwScored.map(s => ({ id: s.id, s: Math.round(s.criticScore?.score ?? 0) })).sort((a,b) => b.s-a.s);
console.log('\nFirst 5 (highest):', scores.slice(0,5));
console.log('\nAround DDA (56):', scores.filter(x => x.s >= 50 && x.s <= 65));
console.log('\nLast 5 (lowest):', scores.slice(-5));
