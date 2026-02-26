// Server component — loads data at build time, passes serialized props to client
import { getBroadwayShows, getOffBroadwayShows, getDataStats, getUpcomingShows } from '@/lib/data-core';
import type { ComputedShow } from '@/lib/data-types';
import { getAudienceBuzz, getAudienceGrade, hasEnoughAudienceReviews } from '@/lib/data-audience';
import HomePageClient from '@/components/HomePageClient';
import type { HomepageShow } from '@/components/HomePageClient';

function serializeShow(show: ComputedShow): HomepageShow {
  const buzz = getAudienceBuzz(show.id);
  return {
    id: show.id,
    slug: show.slug,
    title: show.title,
    venue: show.venue,
    openingDate: show.openingDate,
    closingDate: show.closingDate ?? undefined,
    status: show.status,
    type: show.type,
    isRevival: show.isRevival ?? undefined,
    tags: show.tags,
    ageRecommendation: show.ageRecommendation ?? undefined,
    creativeTeam: show.creativeTeam,
    reviewYearNote: show.reviewYearNote ?? undefined,
    images: show.images,
    criticScore: show.criticScore
      ? { score: show.criticScore.score, reviewCount: show.criticScore.reviewCount }
      : undefined,
    audienceCombinedScore: buzz && hasEnoughAudienceReviews(buzz) ? buzz.combinedScore : null,
    audienceGrade: buzz && hasEnoughAudienceReviews(buzz) ? getAudienceGrade(buzz.combinedScore) : null,
    category: show.category,
  };
}

export default function HomePage() {
  const allShows = getBroadwayShows();
  const stats = getDataStats();
  const upcomingShows = getUpcomingShows();
  const obShows = getOffBroadwayShows().filter(s =>
    (s.status === 'open' || s.status === 'previews') &&
    s.criticScore && s.criticScore.reviewCount !== undefined && s.criticScore.reviewCount >= 5
  );

  return (
    <HomePageClient
      shows={allShows.map(serializeShow)}
      upcomingShows={upcomingShows.map(serializeShow)}
      offBroadwayShows={obShows.map(serializeShow)}
      totalShows={stats.totalShows}
      totalReviews={stats.totalReviews}
    />
  );
}
