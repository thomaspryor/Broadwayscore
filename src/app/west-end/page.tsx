import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { Metadata } from 'next';
import { getWestEndShows } from '@/lib/data-core';
import { getAudienceBuzz, getAudienceGrade, hasEnoughAudienceReviews } from '@/lib/data-audience';
import { generateBreadcrumbSchema, generateItemListSchema, BASE_URL } from '@/lib/seo';
import WestEndPageClient from '@/components/WestEndPageClient';
import type { WestEndShow } from '@/components/WestEndPageClient';
import { featureFlags } from '@/config/feature-flags';

export const metadata: Metadata = {
  title: 'West End Scorecard - London Theatre Ratings & Reviews',
  description: 'CriticScore ratings for London West End shows. See which musicals and plays are getting the best reviews from UK theatre critics.',
  alternates: {
    canonical: `${BASE_URL}/west-end`,
  },
  openGraph: {
    title: 'West End Scorecard - London Theatre Ratings',
    description: 'Aggregated CriticScore ratings for West End shows from The Guardian, Telegraph, Time Out, WhatsOnStage, and more.',
    url: `${BASE_URL}/west-end`,
    type: 'article',
  },
};

// Official West End theatres (SOLT members / Theatreland).
// Anything NOT on this list is classified as Off-West End.
const WEST_END_VENUES = new Set([
  'adelphi', 'aldwych', 'ambassadors', 'apollo', 'apollo victoria',
  'cambridge', 'coliseum', 'london coliseum', 'criterion', 'dominion',
  'duchess', "duke of york's", 'fortune', 'garrick', 'gielgud',
  'harold pinter', "his majesty's", "her majesty's", 'lyceum', 'lyric',
  'london palladium', "noel coward", "noël coward", 'novello', 'palace',
  'peacock', 'phoenix', 'piccadilly', 'playhouse', 'prince edward',
  'prince of wales', "queen's", 'savoy', 'shaftesbury', "st martin's",
  "st. martin's", 'sondheim', 'soho place', 'theatre royal drury lane',
  'theatre royal haymarket', 'trafalgar', 'vaudeville', 'victoria palace',
  "wyndham's", 'wyndhams', 'gillian lynne', 'london hippodrome',
  'the old vic', 'old vic',
]);

function isOffWestEndVenue(venue?: string): boolean {
  if (!venue || venue === 'TBA') return false;
  // Normalize: lowercase, strip "Theatre"/"Theater" suffix, strip parenthetical notes
  const v = venue.trim().toLowerCase()
    .replace(/\s*\(.*\)$/, '')
    .replace(/ theatre$| theater$/, '');
  return !WEST_END_VENUES.has(v);
}

function serializeShow(show: ReturnType<typeof getWestEndShows>[number]): WestEndShow {
  const buzz = getAudienceBuzz(show.id);
  return {
    id: show.id,
    slug: show.slug,
    title: show.title,
    venue: show.venue,
    isOffWestEnd: isOffWestEndVenue(show.venue),
    openingDate: show.openingDate,
    closingDate: show.closingDate ?? undefined,
    status: show.status,
    type: show.type,
    isRevival: show.isRevival ?? undefined,
    reviewYearNote: show.reviewYearNote ?? undefined,
    images: show.images,
    criticScore: show.criticScore
      ? { score: show.criticScore.score, reviewCount: show.criticScore.reviewCount, tier1Count: show.criticScore.tier1Count, tier2Count: show.criticScore.tier2Count }
      : undefined,
    audienceCombinedScore: buzz && hasEnoughAudienceReviews(buzz) ? buzz.combinedScore : null,
    audienceGrade: buzz && hasEnoughAudienceReviews(buzz) ? getAudienceGrade(buzz.combinedScore) : null,
    creativeTeam: show.creativeTeam,
  };
}

export default function WestEndPage() {
  if (!featureFlags.westEnd) {
    notFound();
  }

  const shows = getWestEndShows();

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'West End', url: `${BASE_URL}/west-end` },
  ]);

  // SEO schema excludes previews/upcoming (they have no scores)
  const itemListSchema = generateItemListSchema(
    shows.filter(s => s.status !== 'previews' && s.status !== 'upcoming').map(show => ({
      name: show.title,
      url: `${BASE_URL}/show/${show.slug}`,
      image: show.images?.hero,
      score: show.criticScore?.score ? Math.round(show.criticScore.score) : undefined,
      reviewCount: show.criticScore?.reviewCount,
      venue: show.venue,
      startDate: show.openingDate,
      endDate: show.closingDate,
      status: show.status,
      category: 'west-end',
    })),
    'West End Shows'
  );

  const schemas = [breadcrumbSchema, itemListSchema];

  // Only show WE shows that have critic reviews (hide unscored/TBD shows)
  const scoredShows = shows.filter(s => s.criticScore && s.criticScore.reviewCount >= 1);
  const serializedShows = scoredShows.map(serializeShow);

  // Count reviews across scored WE shows only
  const totalReviews = scoredShows.reduce((sum, s) => sum + (s.criticScore?.reviewCount ?? 0), 0);

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(schemas) }}
      />

      <Suspense>
        <WestEndPageClient
          shows={serializedShows}
          totalShows={scoredShows.length}
          totalReviews={totalReviews}
          scoredShows={scoredShows.length}
        />
      </Suspense>
    </>
  );
}
