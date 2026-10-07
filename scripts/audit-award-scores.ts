/**
 * Audit Award Scores across every show with awards.json data.
 * Surfaces the full sweeper roster + honor-roll counts per tier.
 * Run: npx tsx scripts/audit-award-scores.ts
 */

import { computeSiteAwardScore, categoryToMarket, type TierBadge } from '../src/lib/awards-scoring';
import awardsData from '../data/awards.json';
import showsData from '../data/shows.json';

const shows = (awardsData as { shows: Record<string, unknown> }).shows;
const showList = Array.isArray(showsData) ? showsData : (showsData as { shows: Array<{ id: string; category?: string }> }).shows;
const categoryById = new Map(showList.map((s: { id: string; category?: string }) => [s.id, s.category]));

const rows: Array<{ id: string; score: number; raw: number; badge: TierBadge }> = [];
for (const id of Object.keys(shows)) {
  const r = computeSiteAwardScore(id, categoryToMarket(categoryById.get(id)));
  if (r.displayScore > 0) rows.push({ id, score: r.displayScore, raw: r.rawPoints, badge: r.badge });
}

rows.sort((a, b) => b.score - a.score || b.raw - a.raw);

const counts: Record<TierBadge, number> = {
  sweeper: 0, decorated: 0, honored: 0, nominated: 0, 'in-the-hunt': 0, eligible: 0,
};
for (const r of rows) counts[r.badge]++;

console.log('Tier distribution (current thresholds):');
for (const [tier, n] of Object.entries(counts)) {
  if (n > 0) console.log(`  ${tier.padEnd(12)} ${n}`);
}
console.log(`  total scored: ${rows.length}\n`);

console.log('═══ SWEEPER roster ═══');
for (const r of rows.filter(x => x.badge === 'sweeper')) {
  console.log(`  ${r.score.toString().padStart(3)}  (raw ${r.raw.toString().padStart(5)})  ${r.id}`);
}

console.log('\n═══ Top 30 DECORATED ═══');
for (const r of rows.filter(x => x.badge === 'decorated').slice(0, 30)) {
  console.log(`  ${r.score.toString().padStart(3)}  (raw ${r.raw.toString().padStart(5)})  ${r.id}`);
}

console.log('\n═══ Score distribution histogram ═══');
const buckets = Array(11).fill(0);
for (const r of rows) buckets[Math.min(10, Math.floor(r.score / 10))]++;
for (let i = 0; i < buckets.length; i++) {
  const lo = i * 10;
  const hi = i === 10 ? '+' : `-${i * 10 + 9}`;
  console.log(`  ${lo.toString().padStart(3)}${hi.toString().padEnd(3)}  ${'█'.repeat(Math.ceil(buckets[i] / 5))} ${buckets[i]}`);
}
