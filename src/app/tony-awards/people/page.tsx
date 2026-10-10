import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { featureFlags } from '@/config/feature-flags';
import { getTonyLeaderboard, getTonyNominationsMeta } from '@/lib/data-tony-noms';
import { getActorSlug } from '@/lib/data-actors';
import { getUnifiedSlugForName } from '@/lib/data-creative';
import { generateBreadcrumbSchema, BASE_URL } from '@/lib/seo';
import TonyLeaderboardClient from './TonyLeaderboardClient';

export const metadata: Metadata = {
  title: 'Tony Awards Leaderboard — Most Wins & Nominations',
  description: 'Browse the Tony Awards leaderboard. See which Broadway performers, directors, and designers have the most wins and nominations.',
  alternates: { canonical: `${BASE_URL}/tony-awards/people` },
  openGraph: {
    title: 'Tony Awards Leaderboard',
    description: 'Tony Award winners and nominees ranked by wins and nominations.',
    url: `${BASE_URL}/tony-awards/people`,
    images: [{ url: `${BASE_URL}/og/tony-awards.png`, width: 1200, height: 630, alt: 'Tony Awards Leaderboard' }],
  },
  twitter: { card: 'summary' },
};

export interface LeaderboardRow {
  name: string;
  ibdbPersonId: string;
  nominations: number;
  wins: number;
  actingNominations: number;
  actingWins: number;
  categories: string[];
  showCount: number;
  actingShowCount: number;
  creativeShowCount: number;
  profileUrl: string | null;
}

export default function TonyLeaderboardPage() {
  if (!featureFlags.tonyPeople) notFound();

  const leaderboard = getTonyLeaderboard();
  const meta = getTonyNominationsMeta();

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Tony Awards', url: `${BASE_URL}/tony-awards` },
    { name: 'People', url: `${BASE_URL}/tony-awards/people` },
  ]);

  // ItemList structured data for top winners (helps Google rich results)
  const top10 = leaderboard.slice(0, 10);
  const itemListSchema = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'Tony Awards All-Time Winners Leaderboard',
    description: 'Broadway performers, directors, and designers with the most Tony Award wins.',
    numberOfItems: leaderboard.length,
    itemListElement: top10.map((entry, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: entry.name,
      description: `${entry.wins} Tony wins, ${entry.nominations} nominations across ${entry.shows.length} shows`,
    })),
  };

  // Build profile URLs for each person
  const rows: LeaderboardRow[] = leaderboard.map(entry => {
    // Try actor profile first (by ibdbPersonId), then creative (by name)
    let profileUrl: string | null = null;
    if (entry.ibdbPersonId) {
      const actorSlug = getActorSlug(entry.ibdbPersonId);
      if (actorSlug) profileUrl = `/cast/${actorSlug}`;
    }
    if (!profileUrl) {
      const creativeSlug = getUnifiedSlugForName(entry.name);
      if (creativeSlug) profileUrl = `/creative/${creativeSlug}`;
    }

    return {
      name: entry.name,
      ibdbPersonId: entry.ibdbPersonId,
      nominations: entry.nominations,
      wins: entry.wins,
      actingNominations: entry.actingNominations,
      actingWins: entry.actingWins,
      categories: entry.categories,
      showCount: entry.shows.length,
      actingShowCount: entry.actingShowCount,
      creativeShowCount: entry.creativeShowCount,
      profileUrl,
    };
  });

  return (
    <div className="min-h-screen bg-surface">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([breadcrumbSchema, itemListSchema]) }}
      />
      <TonyLeaderboardClient
        rows={rows}
        totalNominations={meta.totalNominations}
        totalWins={meta.totalWins}
        coverage={meta.coverage}
      />
    </div>
  );
}
