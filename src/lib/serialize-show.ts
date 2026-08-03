import { getAudienceBuzz, hasEnoughAudienceReviews, getAudienceGrade } from '@/lib/data-audience';
import type { ShowCardShow } from '@/components/show-cards/types';

/**
 * Serialize a show for client components (ShowListCard, MiniShowCard).
 *
 * Server components load full ComputedShow objects from data-core, but client
 * components need a plain-object subset that can cross the RSC boundary.
 * Previously, 6+ pages each had their own inline serializer — when a new field
 * was needed (e.g. ticketLinks), it had to be added to each one separately.
 *
 * This centralizes serialization so new fields are added once.
 */
export function serializeShowForClient(
  show: {
    id: string;
    slug: string;
    title: string;
    venue: string;
    openingDate: string;
    closingDate?: string | null;
    previewsStartDate?: string | null;
    status: string;
    type: string;
    isRevival?: boolean | null;
    season?: string | null;
    reviewYearNote?: string | null;
    images?: { thumbnail?: string; poster?: string; hero?: string };
    criticScore?: { score?: number; reviewCount?: number; tier1Count?: number; tier2Count?: number } | null;
    category?: string;
    genre?: string;
    tags?: string[];
    ageRecommendation?: string | null;
    creativeTeam?: Array<{ name: string; role: string }>;
    runtime?: string | null;
    ticketLinks?: Array<{ platform: string; url: string; priceFrom?: number | null }>;
    subtitle?: string;
    subtitleColor?: string;
  },
  overrides?: {
    /** Override audience data (e.g. for pages that compute it differently) */
    audienceCombinedScore?: number | null;
    audienceGrade?: { grade: string; label: string; color: string; textColor: string; tooltip: string } | null;
    /** Override category (e.g. off-broadway pages hardcode 'off-broadway') */
    category?: string;
    /** Market-specific fields */
    isOffWestEnd?: boolean;
    performances?: number;
  },
): ShowCardShow {
  // Compute audience data from buzz unless overrides provided
  const buzz = getAudienceBuzz(show.id);
  const hasAudience = buzz && hasEnoughAudienceReviews(buzz);

  return {
    id: show.id,
    slug: show.slug,
    title: show.title,
    venue: show.venue,
    openingDate: show.openingDate,
    closingDate: show.closingDate ?? undefined,
    previewsStartDate: show.previewsStartDate ?? undefined,
    status: show.status,
    type: show.type,
    isRevival: show.isRevival ?? undefined,
    season: show.season ?? undefined,
    reviewYearNote: show.reviewYearNote ?? undefined,
    images: show.images,
    criticScore: show.criticScore
      ? { score: show.criticScore.score, reviewCount: show.criticScore.reviewCount, tier1Count: show.criticScore.tier1Count, tier2Count: show.criticScore.tier2Count }
      : undefined,
    audienceCombinedScore: overrides?.audienceCombinedScore !== undefined
      ? overrides.audienceCombinedScore
      : (hasAudience ? buzz!.combinedScore : null),
    audienceGrade: overrides?.audienceGrade !== undefined
      ? overrides.audienceGrade
      : (hasAudience ? getAudienceGrade(buzz!.combinedScore) : null),
    category: overrides?.category ?? show.category,
    genre: show.genre,
    tags: show.tags,
    ageRecommendation: show.ageRecommendation ?? undefined,
    creativeTeam: show.creativeTeam,
    runtime: show.runtime ?? undefined,
    ticketLinks: show.ticketLinks,
    subtitle: show.subtitle,
    subtitleColor: show.subtitleColor,
    // Market-specific overrides
    isOffWestEnd: overrides?.isOffWestEnd,
    performances: overrides?.performances,
  };
}

/**
 * Per-render memoized serializer. List pages (homepage, /west-end,
 * /off-broadway) build several overlapping show lists — a Best Recent Shows
 * shelf, a Tony Winners shelf, the full grid, etc. — from the same underlying
 * show data. Calling serializeShowForClient() separately for each occurrence
 * produces a distinct object per call, so React's RSC flight serializer (which
 * dedupes by object reference) re-inlines the full show payload for every
 * shelf a show appears on instead of emitting a single backreference.
 * createShowSerializer() caches by show id (+ overrides fingerprint, so a
 * page that calls it with different overrides for the same show never
 * silently reuses another call site's result) so repeat occurrences within
 * one page render share the same object reference. Scope one instance per
 * page render (not module-level) so overrides don't leak across pages/builds.
 */
export function createShowSerializer() {
  const cache = new Map<string, ShowCardShow>();
  return function serialize(
    show: Parameters<typeof serializeShowForClient>[0],
    overrides?: Parameters<typeof serializeShowForClient>[1],
  ): ShowCardShow {
    const key = overrides ? `${show.id}:${JSON.stringify(overrides)}` : show.id;
    const cached = cache.get(key);
    if (cached) return cached;
    const serialized = serializeShowForClient(show, overrides);
    cache.set(key, serialized);
    return serialized;
  };
}
