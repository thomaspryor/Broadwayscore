import { Metadata } from 'next';
import { BASE_URL } from '@/lib/seo';
import { fantasySocial } from '@/config/fantasy-social';
import FantasyLeaderboardTable from '@/components/fantasy/FantasyLeaderboardTable';
import { getFantasySeasonInfo } from '@/lib/data-fantasy';
import { hasLateEntry } from '@/config/fantasy';

export const metadata: Metadata = {
  title: 'Fantasy League Leaderboard',
  alternates: { canonical: `${BASE_URL}/fantasy/leaderboard` },
  description: 'See who\'s winning the Broadway Fantasy League. Rankings updated daily with points from critics, audiences, box office, and Tony Awards.',
  ...fantasySocial('Leaderboard | Broadway Fantasy League', '/fantasy/leaderboard', 'See who\'s winning the Broadway Fantasy League, updated daily.'),
};

// Leaderboard fetches entries client-side from Supabase API
// (entries are dynamic, not available at build time)
export const dynamic = 'force-dynamic';

const STALE_SCORES_DAYS = 3;

function longDate(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export default function FantasyLeaderboardPage() {
  const seasonInfo = getFantasySeasonInfo();

  // Before the first in-season grosses week lands, the snapshot only carries
  // pre-season weeks: say so instead of showing a "stale" warning in launch
  // week or a September "scores through" date.
  const preSeason = !seasonInfo.latestGrossesWeek || seasonInfo.latestGrossesWeek < seasonInfo.scoringStart;
  const lastScoredMs = seasonInfo.lastScored ? Date.parse(seasonInfo.lastScored) : null;
  const ageDays = lastScoredMs ? Math.floor((Date.now() - lastScoredMs) / 86_400_000) : null;
  const isStale = !preSeason && ageDays != null && ageDays > STALE_SCORES_DAYS;

  return (
    <div className="min-h-screen bg-surface text-white">
      <div className="max-w-4xl mx-auto px-4 py-8 sm:py-12">
        {/* Header */}
        <div className="mb-8">
          <a href="/fantasy" className="text-sm text-fg-muted hover:text-gray-300 transition-colors">
            &larr; Fantasy League
          </a>
          <h1 className="text-2xl sm:text-3xl font-bold mt-2">Leaderboard</h1>
          <p className="text-gray-400 mt-1">
            {seasonInfo.season} Season &middot; {preSeason
              ? `Box office scoring starts ${longDate(seasonInfo.scoringStart)}. Critic and audience points post within a day or two of each opening night.`
              : `Scores through the week ending ${longDate(seasonInfo.latestGrossesWeek)}`}
          </p>
        </div>

        {isStale && (
          <div
            role="status"
            className="mb-6 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
          >
            <span className="font-semibold">Scores may be stale.</span>{' '}
            Last updated {ageDays} days ago. The weekly refresh hasn&apos;t run; standings below will catch up once it does.
          </div>
        )}

        {/* Leaderboard */}
        <FantasyLeaderboardTable />

        {/* Footer */}
        <div className="mt-8 text-center space-y-2">
          <p className="text-sm text-gray-400">
            Points: CriticScore + AudienceGrade + Box Office + Awards. {hasLateEntry()
              ? 'Each team scores box office from the week it drafted.'
              : `Box office counts for every team from ${longDate(seasonInfo.scoringStart)}.`}
          </p>
          <p className="text-sm text-gray-400">
            Last scored: {seasonInfo.lastScored ? new Date(seasonInfo.lastScored).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'N/A'}
          </p>
          <div className="flex gap-4 justify-center mt-4">
            <a
              href="/fantasy/draft"
              className="text-sm text-brand/70 hover:text-brand transition-colors"
            >
              Draft a Team
            </a>
            <a
              href="/fantasy/guide"
              className="text-sm text-brand/70 hover:text-brand transition-colors"
            >
              Draft Guide
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
