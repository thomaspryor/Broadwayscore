/**
 * Shared pick for the two regional shelves: "Pre-Broadway: Out-of-Town Shows"
 * on the home page (US/Canada tryouts) and "Beyond London" on the West End page
 * (UK flagship houses). One ordering so the two cannot drift: running
 * productions first, then most recently opened. Regional runs are limited
 * engagements, so closed shows stay (the score is the point).
 */
import { hasEnoughReviews } from '@/config/score-buckets';

export interface RegionalShelfCandidate {
  status?: string;
  category?: string;
  openingDate?: string | null;
  criticScore?: {
    score?: number | null;
    reviewCount?: number;
    tier1Count?: number;
    tier2Count?: number;
  } | null;
}

/**
 * @param requireEnoughReviews also apply the market's review-count floor
 *   (hasEnoughReviews), so a card never renders with its score hidden as TBD.
 *   Off by default: the Pre-Broadway shelf keeps its long-standing behaviour.
 */
export function pickRegionalShelf<T extends RegionalShelfCandidate>(
  shows: T[],
  { limit = 10, requireEnoughReviews = false }: { limit?: number; requireEnoughReviews?: boolean } = {},
): T[] {
  const isLive = (s: T) => (s.status === 'open' || s.status === 'previews' ? 0 : 1);
  return shows
    .filter(s => s.criticScore?.score)
    .filter(s => !requireEnoughReviews || hasEnoughReviews(
      s.criticScore?.reviewCount ?? 0,
      s.category || 'regional',
      (s.criticScore?.tier1Count ?? 0) + (s.criticScore?.tier2Count ?? 0),
    ))
    .sort((a, b) => {
      if (isLive(a) !== isLive(b)) return isLive(a) - isLive(b);
      return (b.openingDate || '').localeCompare(a.openingDate || '');
    })
    .slice(0, limit);
}
