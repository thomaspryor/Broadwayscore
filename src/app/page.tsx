// Server component — loads data at build time, passes serialized props to client
import type { Metadata } from 'next';
import { getBroadwayShows, getOffBroadwayShows, getDataStats, getUpcomingShows } from '@/lib/data-core';
import type { ComputedShow } from '@/lib/data-types';
import { getAudienceBuzz, getAudienceGrade, hasEnoughAudienceReviews } from '@/lib/data-audience';
import { BASE_URL, generateHomepageFAQSchema } from '@/lib/seo';
import { getOptimizedImageUrl } from '@/lib/images';
import HomePageClient from '@/components/HomePageClient';
import type { HomepageShow } from '@/components/HomePageClient';
import FeaturedRowServer from '@/components/FeaturedRowServer';

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

  // Precompute "Best Recent Musicals" server-side for both preload links and SSR featured row
  const twelveMonthsAgo = new Date();
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
  const bestNewMusicalsShows = allShows
    .filter(s => s.type === 'musical' && s.status === 'open' && new Date(s.openingDate) >= twelveMonthsAgo && s.criticScore?.score)
    .sort((a, b) => (b.criticScore?.score || 0) - (a.criticScore?.score || 0))
    .slice(0, 10)
    .map(serializeShow);

  const featuredPosterUrls = bestNewMusicalsShows
    .slice(0, 4)
    .map(s => {
      const img = s.images?.poster || s.images?.thumbnail;
      return img ? getOptimizedImageUrl(img, 'card') : null;
    })
    .filter((u): u is string => !!u);

  return (
    <>
      {featuredPosterUrls.map((url, i) => (
        <link key={`preload-${i}`} rel="preload" as="image" href={url} fetchPriority={i === 0 ? 'high' : undefined} />
      ))}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(generateHomepageFAQSchema(stats)) }}
      />
      {/* Server-rendered hero + featured row — LCP image appears in initial HTML, no JS needed */}
      <div className="max-w-3xl mx-auto px-4 sm:px-6 pt-5 sm:pt-12">
        <div className="mb-4 sm:mb-8">
          <h1 className="sr-only sm:not-sr-only sm:text-5xl lg:text-6xl font-extrabold text-white mb-3 tracking-tight">
            Broadway<span className="text-gradient">Scorecard</span><span className="text-xs text-gray-400 font-normal align-super ml-0.5">™</span>
          </h1>
          <p className="text-gray-400 text-lg sm:text-xl">
            Every show. Every review. One score.
          </p>
          <p className="text-gray-500 text-sm sm:text-base mt-1">
            {stats.totalShows.toLocaleString()} shows. {stats.totalReviews.toLocaleString()} critic reviews. And counting.
          </p>
        </div>
        <FeaturedRowServer shows={bestNewMusicalsShows} />
      </div>
      <HomePageClient
        shows={allShows.map(serializeShow)}
        upcomingShows={upcomingShows.map(serializeShow)}
        offBroadwayShows={obShows.map(serializeShow)}
        totalShows={stats.totalShows}
        totalReviews={stats.totalReviews}
        skipHero
        skipFirstMusicals
      />
    </>
  );
}
