'use client';

import { useState, useEffect } from 'react';
import type { LeaderboardEntry } from '@/config/fantasy';

export default function FantasyLeaderboardTable() {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedRank, setExpandedRank] = useState<number | null>(null);

  useEffect(() => {
    async function fetchLeaderboard() {
      try {
        const res = await fetch('/api/fantasy/leaderboard');
        const data = await res.json();
        setEntries(data.entries || []);
        if (data.error) setError(data.error);
      } catch {
        setError('Failed to load leaderboard');
      } finally {
        setLoading(false);
      }
    }
    fetchLeaderboard();
  }, []);

  if (loading) {
    return (
      <div className="text-center py-12">
        <div className="inline-block w-6 h-6 border-2 border-amber-500/30 border-t-amber-500 rounded-full animate-spin" />
        <p className="text-zinc-500 text-sm mt-3">Loading leaderboard...</p>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="text-center py-12 bg-zinc-800/30 rounded-xl border border-zinc-700/50">
        <p className="text-zinc-400 text-lg mb-2">No entries yet</p>
        <p className="text-zinc-600 text-sm mb-6">Be the first to draft a team!</p>
        <a
          href="/fantasy/draft"
          className="px-6 py-2.5 bg-amber-500 text-black font-semibold rounded-lg hover:bg-amber-400 transition-colors"
        >
          Draft Now
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Header row */}
      <div className="hidden sm:grid grid-cols-[3rem_1fr_5rem_5rem_5rem_5rem_5rem] gap-2 px-4 py-2 text-xs text-zinc-500 uppercase tracking-wider">
        <span>#</span>
        <span>Team</span>
        <span className="text-right">Critics</span>
        <span className="text-right">Audience</span>
        <span className="text-right">Box Office</span>
        <span className="text-right">Awards</span>
        <span className="text-right font-bold">Total</span>
      </div>

      {entries.map(entry => (
        <div key={entry.rank}>
          {/* Main row */}
          <button
            className={`w-full grid grid-cols-[3rem_1fr_auto] sm:grid-cols-[3rem_1fr_5rem_5rem_5rem_5rem_5rem] gap-2 items-center px-4 py-3 rounded-lg transition-colors text-left ${
              expandedRank === entry.rank
                ? 'bg-zinc-800 border border-zinc-600'
                : 'bg-zinc-800/50 hover:bg-zinc-800 border border-transparent'
            } ${entry.rank <= 3 ? 'border-l-2 border-l-amber-500/50' : ''}`}
            onClick={() => setExpandedRank(expandedRank === entry.rank ? null : entry.rank)}
          >
            {/* Rank */}
            <span className={`text-lg font-bold ${
              entry.rank === 1 ? 'text-amber-400' : entry.rank === 2 ? 'text-zinc-300' : entry.rank === 3 ? 'text-amber-700' : 'text-zinc-500'
            }`}>
              {entry.rank}
            </span>

            {/* Name */}
            <span className="font-medium text-white truncate">{entry.displayName}</span>

            {/* Desktop: breakdown columns */}
            <span className="hidden sm:block text-right text-sm text-zinc-400">
              {entry.pointBreakdown.criticScore}
            </span>
            <span className="hidden sm:block text-right text-sm text-zinc-400">
              {entry.pointBreakdown.audienceGrade}
            </span>
            <span className="hidden sm:block text-right text-sm text-zinc-400">
              {entry.pointBreakdown.boxOffice.toFixed(1)}
            </span>
            <span className="hidden sm:block text-right text-sm text-zinc-400">
              {entry.pointBreakdown.awards}
            </span>

            {/* Total */}
            <span className="text-right font-bold text-amber-400 sm:text-base">
              {entry.totalPoints.toFixed(1)}
            </span>
          </button>

          {/* Expanded picks */}
          {expandedRank === entry.rank && (
            <div className="ml-12 mr-4 mb-2 mt-1 bg-zinc-900/50 rounded-lg p-3 space-y-1.5">
              <p className="text-xs text-zinc-500 uppercase tracking-wider mb-2">Picks</p>
              {entry.picks.map((pick, i) => (
                <div key={pick.showId} className="flex items-center justify-between text-sm">
                  <span className="text-zinc-300">
                    <span className="text-zinc-600 mr-2">{i + 1}.</span>
                    {pick.showTitle}
                    <span className="text-zinc-600 ml-2">(${pick.price})</span>
                  </span>
                  <span className={`font-mono ${pick.points > 0 ? 'text-emerald-400' : 'text-zinc-600'}`}>
                    {pick.points.toFixed(1)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}

      {error && (
        <p className="text-center text-xs text-zinc-600 mt-4">{error}</p>
      )}
    </div>
  );
}
