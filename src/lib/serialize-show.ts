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
    reviewYearNote?: string | null;
    images?: { thumbnail?: string; poster?: string; hero?: string };
    criticScore?: { score?: number; reviewCount?: number; tier1Count?: number; tier2Count?: number } | null;
    category?: string;
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
