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
  description: 'Browse the all-time Tony Awards leaderboard. See which Broadway performers, directors, and designers have the most wins and nominations.',
  alternates: { canonical: `${BASE_URL}/tony-awards/people` },
  openGraph: {
    title: 'Tony Awards Leaderboard',
    description: 'All-time Tony Award winners and nominees ranked by wins and nominations.',
    url: `${BASE_URL}/tony-awards/people`,
    images: [{ url: `${BASE_URL}/og/home.png`, width: 1200, height: 630 }],
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
      profileUrl,
    };
  });

  return (
    <div className="min-h-screen bg-surface">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }}
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
