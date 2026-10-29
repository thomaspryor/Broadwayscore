'use client';

import { useState, useEffect } from 'react';
import type { LeaderboardEntry } from '@/config/fantasy';

const EMAIL_FORMAT_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function FantasyLeaderboardTable() {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped by "Try again": re-runs the same fetch, keeping the search box.
  const [retry, setRetry] = useState(0);
  const [expandedRank, setExpandedRank] = useState<number | null>(null);
  const [leagueFilter, setLeagueFilter] = useState('');
  const [debouncedLeague, setDebouncedLeague] = useState('');
  const [emailFilter, setEmailFilter] = useState('');
  const [debouncedEmail, setDebouncedEmail] = useState('');
  const [emailNotFound, setEmailNotFound] = useState(false);
  // While the draft is open the API sends team names only (see fantasy-roster-privacy).
  const [hidden, setHidden] = useState<{ total: number; revealsOn: string } | null>(null);

  // Debounce league filter (500ms)
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedLeague(leagueFilter), 500);
    return () => clearTimeout(timer);
  }, [leagueFilter]);

  // Debounce email search (500ms) — email search takes priority over league
  // filter. Only fires once the input is a complete email address, so
  // every keystroke of a partial address doesn't round-trip to the server.
  useEffect(() => {
    const trimmed = emailFilter.trim();
    const timer = setTimeout(() => setDebouncedEmail(EMAIL_FORMAT_RE.test(trimmed) ? trimmed : ''), 500);
    return () => clearTimeout(timer);
  }, [emailFilter]);

  useEffect(() => {
    async function fetchLeaderboard() {
      setLoading(true);
      setEmailNotFound(false);
      setError(null);
      try {
        const url = debouncedEmail
          ? `/api/fantasy/leaderboard?email=${encodeURIComponent(debouncedEmail)}`
          : debouncedLeague
          ? `/api/fantasy/leaderboard?league=${encodeURIComponent(debouncedLeague)}`
          : '/api/fantasy/leaderboard';
        const res = await fetch(url);
        const data = await res.json();
        setEntries(data.entries || []);
        setHidden(data.meta?.picksHidden
          ? { total: data.meta.totalEntries ?? 0, revealsOn: data.meta.revealsOn }
          : null);
        if (debouncedEmail && data.entries?.length === 0 && !data.error && !data.meta?.picksHidden) setEmailNotFound(true);
        if (debouncedEmail && data.meta?.picksHidden && data.meta.notFound) setEmailNotFound(true);
        if (data.error) setError(data.error);
      } catch {
        setError('Failed to load leaderboard');
      } finally {
        setLoading(false);
      }
    }
    fetchLeaderboard();
  }, [debouncedLeague, debouncedEmail, retry]);

  if (loading) {
    return (
      <div className="text-center py-12">
        <div className="inline-block w-6 h-6 border-2 border-brand/30 border-t-brand rounded-full animate-spin" />
        <p className="text-fg-muted text-sm mt-3">Loading leaderboard...</p>
      </div>
    );
  }

  const filterBar = (
    <div className="flex flex-col sm:flex-row gap-2 mb-2">
      <div className="flex-1 flex items-center gap-2">
        <input
          type="email"
          className="flex-1 bg-surface-raised border border-white/10 rounded-lg px-3 py-2 text-base sm:text-sm text-white placeholder-gray-500 focus:border-brand/50 focus:outline-none transition-colors"
          placeholder="Find your team by email..."
          value={emailFilter}
          onChange={e => setEmailFilter(e.target.value)}
        />
        {emailFilter && (
          <button
            onClick={() => setEmailFilter('')}
            className="text-xs text-fg-muted hover:text-white transition-colors"
          >
            Clear
          </button>
        )}
      </div>
      <div className="flex-1 flex items-center gap-2">
        <input
          type="text"
          className="flex-1 bg-surface-raised border border-white/10 rounded-lg px-3 py-2 text-base sm:text-sm text-white placeholder-gray-500 focus:border-brand/50 focus:outline-none transition-colors disabled:opacity-40"
          placeholder="Filter by league name..."
          value={leagueFilter}
          onChange={e => setLeagueFilter(e.target.value)}
          disabled={!!emailFilter}
        />
        {leagueFilter && (
          <button
            onClick={() => setLeagueFilter('')}
            className="text-xs text-fg-muted hover:text-white transition-colors"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );

  if (hidden && hidden.total > 0 && !emailNotFound && !error) {
    const reveal = new Date(`${hidden.revealsOn}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
    return (
      <div className="space-y-2">
        {filterBar}
        <div className="text-center py-12 px-4 bg-surface-raised/30 rounded-xl border border-white/5">
          <p className="text-gray-200 text-lg mb-2">
            {debouncedEmail ? 'We found your team.' : `${hidden.total} ${hidden.total === 1 ? 'team has' : 'teams have'} drafted so far.`}
          </p>
          <p className="text-gray-400 text-base">
            Picks and standings stay hidden until the draft closes on {reveal}, so nobody can copy a rival. {debouncedEmail ? 'Your picks are in your confirmation email.' : ''}
          </p>
        </div>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="space-y-2">
        {filterBar}
        <div className="text-center py-12 bg-surface-raised/30 rounded-xl border border-white/5">
          {error ? (
            // A failed load must not read as an empty season (BRO-5548 audit).
            <>
              <p className="text-gray-400 text-lg mb-2">{debouncedEmail ? 'That search did not work' : 'The leaderboard did not load'}</p>
              <p className="text-fg-muted text-sm mb-6">{error}</p>
              <button
                type="button"
                onClick={() => setRetry(n => n + 1)}
                className="px-6 py-2.5 bg-brand text-white font-semibold rounded-lg hover:bg-brand-hover transition-colors"
              >
                Try again
              </button>
            </>
          ) : emailNotFound ? (
            <>
              <p className="text-gray-400 text-lg mb-2">No team found for that email</p>
              <p className="text-fg-muted text-sm">Check the address you drafted with and try again.</p>
            </>
          ) : (
            <>
              <p className="text-gray-400 text-lg mb-2">No entries yet</p>
              <p className="text-fg-muted text-sm mb-6">Be the first to draft a team!</p>
              <a
                href="/fantasy/draft"
                className="px-6 py-2.5 bg-brand text-white font-semibold rounded-lg hover:bg-brand-hover transition-colors"
              >
                Draft Now
              </a>
            </>
          )}
        </div>
      </div>
    );
  }

  const anyPoints = entries.some(e => e.totalPoints > 0);

  return (
    <div className="space-y-2">
      {filterBar}

      <p className="text-xs text-fg-muted px-1">
        {entries.length} {entries.length === 1 ? 'team' : 'teams'}{debouncedLeague ? ' in this league' : ''}. Tap a team to see its picks.
      </p>

      {/* Header row */}
      <div className="hidden sm:grid grid-cols-[3rem_1fr_5rem_5rem_5rem_5rem_5rem] gap-2 px-4 py-2 text-xs text-fg-muted uppercase tracking-wider">
        <span>#</span>
        <span>Team</span>
        <span className="text-right">Critics</span>
        <span className="text-right">Audience</span>
        <span className="text-right">Box Office</span>
        <span className="text-right">Awards</span>
        <span className="text-right font-bold">Total</span>
      </div>

      {entries.map((entry, idx) => {
        // Before any points post (the draft window), every team ties at 0:
        // show no rank rather than a field full of gold #1s.
        const ranked = anyPoints;
        return (
        <div key={entry.id ?? `${entry.rank}-${entry.displayName}-${idx}`}>
          {/* Main row */}
          <button
            className={`w-full grid grid-cols-[3rem_1fr_auto] sm:grid-cols-[3rem_1fr_5rem_5rem_5rem_5rem_5rem] gap-2 items-center px-4 py-3 rounded-lg transition-colors text-left ${
              expandedRank === idx
                ? 'bg-surface-raised border border-white/10'
                : 'bg-surface-raised/50 hover:bg-surface-raised border border-transparent'
            } ${ranked && entry.rank <= 3 ? 'border-l-2 border-l-brand/50' : ''}`}
            onClick={() => setExpandedRank(expandedRank === idx ? null : idx)}
          >
            {/* Rank */}
            <span className={`text-lg font-bold ${
              !ranked ? 'text-fg-muted' : entry.rank === 1 ? 'text-brand' : entry.rank === 2 ? 'text-gray-300' : entry.rank === 3 ? 'text-brand-hover' : 'text-fg-muted'
            }`}>
              {ranked ? entry.rank : '–'}
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
            <div className="ml-12 mr-4 mb-2 mt-1 bg-surface-raised/50 rounded-lg p-3 space-y-1.5">
              <p className="text-xs text-fg-muted uppercase tracking-wider mb-2">Picks</p>
              {entry.picks.map((pick, i) => (
                <div key={pick.showId} className="flex items-center justify-between text-sm gap-3">
                  <span className="text-gray-300">
                    <span className="text-fg-muted mr-2">{i + 1}.</span>
                    {pick.showTitle}
                    <span className="text-fg-muted ml-2">(${pick.price})</span>
                    {pick.scoreLocked && (
                      <span className="text-fg-muted ml-2 text-xs">drafted after opening</span>
                    )}
                  </span>
                  <span className={`font-mono ${pick.points > 0 ? 'text-emerald-400' : 'text-fg-muted'}`}>
                    {pick.points.toFixed(1)}
                  </span>
                </div>
              ))}
              {entry.scoringFrom && (
                <p className="text-xs text-fg-muted pt-1">
                  Box office counted from the week of {new Date(`${entry.scoringFrom}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}.
                </p>
              )}
            </div>
          )}
        </div>
        );
      })}

      {error && (
        <p className="text-center text-xs text-fg-muted mt-4">{error}</p>
      )}
    </div>
  );
}
