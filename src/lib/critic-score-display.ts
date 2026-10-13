// Whether the site shows a show's Critic Score (vs "TBD"): THE display gate,
// shared by score badges, browse lists, SEO aggregateRating and FAQ copy, and
// (via scripts/lib/min-reviews.js) the slim files' `cs` (BRO-4312). Re-deriving
// it from getMarketMinReviews() alone dropped the +2 T3-only rule and the
// curated-historical carve-out, so a page could say TBD while its schema
// claimed a rating, or the reverse.
import { hasEnoughReviews } from '@/config/score-buckets';
import { CURATED_HISTORICAL_SHOWS } from '@/config/scoring';

interface ShowWithCriticScore {
  id?: string;
  category?: string;
  criticScore?: { reviewCount?: number; tier1Count?: number; tier2Count?: number } | null;
}

export function displaysCriticScore(show: ShowWithCriticScore): boolean {
  const cs = show.criticScore;
  if (!cs) return false;
  return hasEnoughReviews(
    cs.reviewCount ?? 0,
    show.category,
    // Unknown tier counts → undefined (no T3-only penalty), as ScoreBadge does.
    cs.tier1Count === undefined && cs.tier2Count === undefined ? undefined : (cs.tier1Count ?? 0) + (cs.tier2Count ?? 0),
    !!show.id && CURATED_HISTORICAL_SHOWS.has(show.id),
  );
}
