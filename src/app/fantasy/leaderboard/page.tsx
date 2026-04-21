import { Metadata } from 'next';
import FantasyLeaderboardTable from '@/components/fantasy/FantasyLeaderboardTable';
import { getFantasySeasonInfo } from '@/lib/data-fantasy';

export const metadata: Metadata = {
  title: 'Fantasy League Leaderboard',
  description: 'See who\'s winning the Broadway Fantasy League. Rankings updated weekly with points from critics, audiences, box office, and Tony Awards.',
};

// Leaderboard fetches entries client-side from Supabase API
// (entries are dynamic, not available at build time)
export const dynamic = 'force-dynamic';

const STALE_SCORES_DAYS = 3;

export default function FantasyLeaderboardPage() {
  const seasonInfo = getFantasySeasonInfo();

  const lastScoredMs = seasonInfo.lastScored ? Date.parse(seasonInfo.lastScored) : null;
  const ageDays = lastScoredMs ? Math.floor((Date.now() - lastScoredMs) / 86_400_000) : null;
  const isStale = ageDays != null && ageDays > STALE_SCORES_DAYS;

  return (
    <div className="min-h-screen bg-surface text-white">
      <div className="max-w-4xl mx-auto px-4 py-8 sm:py-12">
        {/* Header */}
        <div className="mb-8">
          <a href="/fantasy" className="text-sm text-gray-500 hover:text-gray-300 transition-colors">
            &larr; Fantasy League
          </a>
          <h1 className="text-2xl sm:text-3xl font-bold mt-2">Leaderboard</h1>
          <p className="text-gray-400 mt-1">
            {seasonInfo.season} Season &middot; Scores through week of {seasonInfo.latestGrossesWeek || 'N/A'}
          </p>
        </div>

        {isStale && (
          <div
            role="status"
            className="mb-6 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
          >
            <span className="font-semibold">Scores may be stale.</span>{' '}
            Last updated {ageDays} days ago — the weekly refresh hasn&apos;t run. Standings below will catch up once it does.
          </div>
        )}

        {/* Leaderboard */}
        <FantasyLeaderboardTable />

        {/* Footer */}
        <div className="mt-8 text-center space-y-2">
          <p className="text-xs text-gray-600">
            Points: CriticScore + AudienceGrade + Box Office + Tony Awards
          </p>
          <p className="text-xs text-gray-600">
            Last scored: {seasonInfo.lastScored ? new Date(seasonInfo.lastScored).toLocaleDateString() : 'N/A'}
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
