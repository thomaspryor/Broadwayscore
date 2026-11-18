// BRO-7803 parity audit. For every show: (1) the extracted gate computeShowTBD equals the legacy inline formula the
// show page used before the extraction (copied verbatim from the old page.tsx), (2) the overlay view model agrees with it,
// (3) the overlay reviewCount equals the count JSON-LD / the page heading use (criticScore.reviewCount).
import { getAllShows } from '../src/lib/data';
import { buildScoreRegionView } from '../src/lib/live-score/view';
import { computeShowTBD } from '../src/lib/show-score-tbd';
import { hasEnoughReviews, applyCoverageFloor } from '../src/config/score-buckets';
import { scoreGateArg } from '../src/config/scoring';

let bad = 0;
const shows: any[] = getAllShows() as any[];
for (const s of shows) {
  const reviewCount = s.criticScore?.reviewCount ?? 0;
  const t12 = (s.criticScore?.tier1Count ?? 0) + (s.criticScore?.tier2Count ?? 0);
  const legacy = applyCoverageFloor(
    !hasEnoughReviews(reviewCount, s.category, t12, scoreGateArg(s.id)) || s.status === 'previews' || s.status === 'upcoming',
    { scorePublicSince: s.scorePublicSince, coverageState: s.cov?.state, coverageAcked: s.coverageAcked },
  );
  const v = buildScoreRegionView(s, false);
  if (computeShowTBD(s) !== legacy) { bad++; console.log('MISMATCH shared gate vs legacy', s.id); }
  if (v.showTBD !== legacy) { bad++; console.log('MISMATCH view.showTBD vs legacy', s.id); }
  if (v.reviewCount !== reviewCount) { bad++; console.log('MISMATCH reviewCount', s.id, v.reviewCount, reviewCount); }
  if (!v.showTBD && v.score == null) { bad++; console.log('MISMATCH scored without score', s.id); }
}
console.log(`parity: ${shows.length} shows, ${bad} mismatches`);
process.exit(bad ? 1 : 0);
