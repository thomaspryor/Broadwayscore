// Server component — loads data at build time, passes serialized props to client
import type { Metadata } from 'next';
import { getBroadwayShows, getOffBroadwayShows, getDataStats, getUpcomingShows } from '@/lib/data-core';
import type { ComputedShow } from '@/lib/data-types';
import { getAudienceBuzz, getAudienceGrade, hasEnoughAudienceReviews } from '@/lib/data-audience';
import { BASE_URL } from '@/lib/seo';
import HomePageClient from '@/components/HomePageClient';
import type { HomepageShow } from '@/components/HomePageClient';

const homeOgImageUrl = `${BASE_URL}/og/home.png`;

export const metadata: Metadata = {
  title: 'Broadway Scorecard — Best Broadway Shows 2026 | Aggregated Critic Reviews & Ratings',
  description: 'Find the best Broadway shows with scores aggregated from every major critic. Compare ratings from The New York Times, Vulture, Variety, and 400+ outlets. Updated daily.',
  alternates: {
    canonical: BASE_URL,
  },
  openGraph: {
    title: 'Broadway Scorecard — Best Broadway Shows 2026',
    description: 'Find the best Broadway shows with scores aggregated from every major critic. Compare ratings from The New York Times, Vulture, Variety, and 400+ outlets.',
    url: BASE_URL,
    images: [{ url: homeOgImageUrl, width: 1200, height: 630, alt: 'Broadway Scorecard — Aggregated Critic Scores for Every Broadway Show' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Broadway Scorecard — Best Broadway Shows 2026',
    description: 'Aggregated critic scores for every Broadway show. Compare ratings from 400+ outlets.',
    images: [{ url: homeOgImageUrl, width: 1200, height: 630, alt: 'Broadway Scorecard — Aggregated Critic Scores for Every Broadway Show' }],
  },
};

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
      ? { score: show.criticScore.score, reviewCount: show.criticScore.reviewCount, tier1Count: show.criticScore.tier1Count, tier2Count: show.criticScore.tier2Count }
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
