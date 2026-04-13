'use client';

import { useState, useEffect } from 'react';
import type { LeaderboardEntry } from '@/config/fantasy';

export default function FantasyLeaderboardTable() {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedRank, setExpandedRank] = useState<number | null>(null);
  const [leagueFilter, setLeagueFilter] = useState('');
  const [debouncedLeague, setDebouncedLeague] = useState('');

  // Debounce league filter (500ms)
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedLeague(leagueFilter), 500);
    return () => clearTimeout(timer);
  }, [leagueFilter]);

  useEffect(() => {
    async function fetchLeaderboard() {
      setLoading(true);
      try {
        const url = debouncedLeague
          ? `/api/fantasy/leaderboard?league=${encodeURIComponent(debouncedLeague)}`
          : '/api/fantasy/leaderboard';
        const res = await fetch(url);
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
  }, [debouncedLeague]);

  if (loading) {
    return (
      <div className="text-center py-12">
        <div className="inline-block w-6 h-6 border-2 border-brand/30 border-t-brand rounded-full animate-spin" />
        <p className="text-gray-500 text-sm mt-3">Loading leaderboard...</p>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="text-center py-12 bg-surface-raised/30 rounded-xl border border-white/5">
        <p className="text-gray-400 text-lg mb-2">No entries yet</p>
        <p className="text-gray-600 text-sm mb-6">Be the first to draft a team!</p>
        <a
          href="/fantasy/draft"
          className="px-6 py-2.5 bg-brand text-white font-semibold rounded-lg hover:bg-brand-hover transition-colors"
        >
          Draft Now
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* League filter */}
      <div className="flex items-center gap-2 mb-2">
        <input
          type="text"
          className="flex-1 bg-surface-raised border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-brand/50 focus:outline-none transition-colors"
          placeholder="Filter by league name..."
          value={leagueFilter}
          onChange={e => setLeagueFilter(e.target.value)}
        />
        {leagueFilter && (
          <button
            onClick={() => setLeagueFilter('')}
            className="text-xs text-gray-500 hover:text-white transition-colors"
          >
            Clear
          </button>
        )}
      </div>

      {/* Header row */}
      <div className="hidden sm:grid grid-cols-[3rem_1fr_5rem_5rem_5rem_5rem_5rem] gap-2 px-4 py-2 text-xs text-gray-500 uppercase tracking-wider">
        <span>#</span>
        <span>Team</span>
        <span className="text-right">Critics</span>
        <span className="text-right">Audience</span>
        <span className="text-right">Box Office</span>
        <span className="text-right">Awards</span>
        <span className="text-right font-bold">Total</span>
      </div>

      {entries.map((entry, idx) => (
        <div key={`${entry.rank}-${entry.displayName}`}>
          {/* Main row */}
          <button
            className={`w-full grid grid-cols-[3rem_1fr_auto] sm:grid-cols-[3rem_1fr_5rem_5rem_5rem_5rem_5rem] gap-2 items-center px-4 py-3 rounded-lg transition-colors text-left ${
              expandedRank === idx
                ? 'bg-surface-raised border border-white/10'
                : 'bg-surface-raised/50 hover:bg-surface-raised border border-transparent'
            } ${entry.rank <= 3 ? 'border-l-2 border-l-brand/50' : ''}`}
            onClick={() => setExpandedRank(expandedRank === idx ? null : idx)}
          >
            {/* Rank */}
            <span className={`text-lg font-bold ${
              entry.rank === 1 ? 'text-brand' : entry.rank === 2 ? 'text-gray-300' : entry.rank === 3 ? 'text-brand-hover' : 'text-gray-500'
            }`}>
              {entry.rank}
            </span>

            {/* Name */}
            <span className="font-medium text-white truncate">{entry.displayName}</span>

            {/* Desktop: breakdown columns */}
            <span className="hidden sm:block text-right text-sm text-gray-400">
              {entry.pointBreakdown.criticScore}
            </span>
            <span className="hidden sm:block text-right text-sm text-gray-400">
              {entry.pointBreakdown.audienceGrade}
            </span>
            <span className="hidden sm:block text-right text-sm text-gray-400">
              {entry.pointBreakdown.boxOffice.toFixed(1)}
            </span>
            <span className="hidden sm:block text-right text-sm text-gray-400">
              {entry.pointBreakdown.awards}
            </span>

            {/* Total */}
            <span className="text-right font-bold text-brand sm:text-base">
              {entry.totalPoints.toFixed(1)}
            </span>
          </button>

          {/* Expanded picks */}
          {expandedRank === idx && (
            <div className="ml-12 mr-4 mb-2 mt-1 bg-surface/50 rounded-lg p-3 space-y-1.5">
              <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Picks</p>
              {entry.picks.map((pick, i) => (
                <div key={pick.showId} className="flex items-center justify-between text-sm">
                  <span className="text-gray-300">
                    <span className="text-gray-600 mr-2">{i + 1}.</span>
                    {pick.showTitle}
                    <span className="text-gray-600 ml-2">(${pick.price})</span>
                  </span>
                  <span className={`font-mono ${pick.points > 0 ? 'text-emerald-400' : 'text-gray-600'}`}>
                    {pick.points.toFixed(1)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}

      {error && (
        <p className="text-center text-xs text-gray-600 mt-4">{error}</p>
      )}
    </div>
  );
}
