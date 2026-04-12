'use client';

import { useState, useMemo } from 'react';
import FantasyShowPicker from '@/components/fantasy/FantasyShowPicker';
import FantasyBudgetBar from '@/components/fantasy/FantasyBudgetBar';
import {
  FANTASY_BUDGET,
  FANTASY_TEAM_SIZE,
  DRAFT_DEADLINE,
  isDraftClosed,
} from '@/config/fantasy';
import type { FantasyShow } from '@/config/fantasy';

// Import show data at build time (bundled into client)
import fantasyLeagueData from '../../../../data/fantasy-league.json';

type FantasyConfig = {
  _meta: { season: string; draftDeadline: string; budget: number; teamSize: number };
  shows: Record<string, FantasyShow>;
};

const config = fantasyLeagueData as unknown as FantasyConfig;

export default function FantasyDraftPage() {
  const [email, setEmail] = useState('');
  const [teamName, setTeamName] = useState('');
  const [leagueName, setLeagueName] = useState('');
  const [picks, setPicks] = useState<string[]>(Array(FANTASY_TEAM_SIZE).fill(''));
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const draftClosed = isDraftClosed();

  const allShows = useMemo(() => {
    return Object.entries(config.shows)
      .map(([id, show]) => ({ id, ...show }))
      .sort((a, b) => b.price - a.price);
  }, []);

  const selectedIds = picks.filter(Boolean);
  const totalSpent = selectedIds.reduce((sum, id) => {
    const show = config.shows[id];
    return sum + (show?.price ?? 0);
  }, 0);
  const remainingBudget = FANTASY_BUDGET - totalSpent;

  const canSubmit =
    !draftClosed &&
    !submitting &&
    email.includes('@') &&
    selectedIds.length === FANTASY_TEAM_SIZE &&
    totalSpent <= FANTASY_BUDGET;

  function handleSelect(showId: string, slotIndex: number) {
    setPicks(prev => {
      const next = [...prev];
      next[slotIndex] = showId;
      return next;
    });
    setError(null);
  }

  function handleRemove(showId: string) {
    setPicks(prev => prev.map(id => (id === showId ? '' : id)));
    setError(null);
  }

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch('/api/fantasy/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          team_name: teamName.trim() || null,
          league_name: leagueName.trim() || null,
          picks: selectedIds,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Something went wrong');
        return;
      }

      setSubmitted(true);
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  // Confirmation screen
  if (submitted) {
    return (
      <div className="min-h-screen bg-zinc-950 text-white">
        <div className="max-w-2xl mx-auto px-4 py-16 text-center">
          <div className="text-6xl mb-6">🎭</div>
          <h1 className="text-3xl font-bold mb-4">You&apos;re In!</h1>
          <p className="text-zinc-400 mb-2">
            Your {FANTASY_TEAM_SIZE} picks have been locked in
            {teamName ? ` as "${teamName}"` : ''}.
          </p>
          <p className="text-zinc-400 mb-8">
            Total spent: <span className="text-emerald-400 font-bold">${totalSpent}</span> / ${FANTASY_BUDGET}
          </p>

          <div className="bg-zinc-800/50 rounded-xl p-6 mb-8 text-left">
            <h2 className="text-sm text-zinc-500 uppercase tracking-wider mb-3">Your Team</h2>
            <div className="space-y-2">
              {selectedIds.map((id, i) => {
                const show = config.shows[id];
                return (
                  <div key={id} className="flex items-center justify-between">
                    <span className="text-zinc-300">{i + 1}. {show?.title}</span>
                    <span className="text-emerald-400 font-mono">${show?.price}</span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <a
              href="/fantasy/leaderboard"
              className="px-6 py-3 bg-amber-500 text-black font-semibold rounded-lg hover:bg-amber-400 transition-colors"
            >
              View Leaderboard
            </a>
            <a
              href="/fantasy"
              className="px-6 py-3 bg-zinc-800 text-white rounded-lg hover:bg-zinc-700 transition-colors"
            >
              Back to Fantasy Home
            </a>
          </div>
        </div>
      </div>
    );
  }

  // Draft closed screen
  if (draftClosed) {
    return (
      <div className="min-h-screen bg-zinc-950 text-white">
        <div className="max-w-2xl mx-auto px-4 py-16 text-center">
          <h1 className="text-3xl font-bold mb-4">Draft Window Closed</h1>
          <p className="text-zinc-400 mb-8">
            The draft deadline has passed. Check the leaderboard to see how teams are performing!
          </p>
          <a
            href="/fantasy/leaderboard"
            className="px-6 py-3 bg-amber-500 text-black font-semibold rounded-lg hover:bg-amber-400 transition-colors"
          >
            View Leaderboard
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <div className="max-w-2xl mx-auto px-4 py-8 sm:py-12">
        {/* Header */}
        <div className="mb-8">
          <a href="/fantasy" className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors">
            &larr; Fantasy League
          </a>
          <h1 className="text-2xl sm:text-3xl font-bold mt-2">Draft Your Team</h1>
          <p className="text-zinc-400 mt-1">
            Pick {FANTASY_TEAM_SIZE} shows. ${FANTASY_BUDGET} budget. One entry per email.
          </p>
        </div>

        {/* Email + Team info */}
        <div className="space-y-4 mb-6">
          <div>
            <label className="block text-sm text-zinc-400 mb-1">Email *</label>
            <input
              type="email"
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-2.5 text-white placeholder-zinc-500 focus:border-amber-500/50 focus:outline-none transition-colors"
              placeholder="you@email.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
            />
            <p className="text-xs text-zinc-600 mt-1">One entry per email. Re-submitting replaces your previous picks.</p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-zinc-400 mb-1">Team Name</label>
              <input
                type="text"
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-2.5 text-white placeholder-zinc-500 focus:border-amber-500/50 focus:outline-none transition-colors"
                placeholder="Optional"
                value={teamName}
                onChange={e => setTeamName(e.target.value)}
                maxLength={50}
              />
            </div>
            <div>
              <label className="block text-sm text-zinc-400 mb-1">League Name</label>
              <input
                type="text"
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-2.5 text-white placeholder-zinc-500 focus:border-amber-500/50 focus:outline-none transition-colors"
                placeholder="Optional"
                value={leagueName}
                onChange={e => setLeagueName(e.target.value)}
                maxLength={50}
              />
              <p className="text-xs text-zinc-600 mt-1">Same name = same league</p>
            </div>
          </div>
        </div>

        {/* Budget Bar */}
        <div className="mb-6">
          <FantasyBudgetBar
            spent={totalSpent}
            budget={FANTASY_BUDGET}
            picksCount={selectedIds.length}
            teamSize={FANTASY_TEAM_SIZE}
          />
        </div>

        {/* Show Pickers */}
        <div className="space-y-3 mb-8">
          <h2 className="text-sm text-zinc-500 uppercase tracking-wider">Your {FANTASY_TEAM_SIZE} Picks</h2>
          {picks.map((_, index) => (
            <FantasyShowPicker
              key={index}
              shows={allShows}
              selectedIds={picks}
              onSelect={(showId) => handleSelect(showId, index)}
              onRemove={handleRemove}
              remainingBudget={remainingBudget}
              slotIndex={index}
            />
          ))}
        </div>

        {/* Legend */}
        <div className="text-xs text-zinc-600 mb-6 space-y-1">
          <p>★ locked = CriticScore already set (points won&apos;t change)</p>
          <p>† no box office = Off-Broadway shows don&apos;t report weekly grosses</p>
          <p>OB = Off-Broadway (not Tony-eligible)</p>
        </div>

        {/* Error */}
        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 mb-4 text-red-400 text-sm">
            {error}
          </div>
        )}

        {/* Submit */}
        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className={`w-full py-3.5 rounded-lg font-semibold text-lg transition-all ${
            canSubmit
              ? 'bg-amber-500 text-black hover:bg-amber-400 active:scale-[0.98]'
              : 'bg-zinc-700 text-zinc-500 cursor-not-allowed'
          }`}
        >
          {submitting ? 'Submitting...' : `Lock In My ${FANTASY_TEAM_SIZE} Picks`}
        </button>

        {!canSubmit && !submitting && selectedIds.length > 0 && (
          <p className="text-center text-xs text-zinc-500 mt-2">
            {!email.includes('@')
              ? 'Enter your email to submit'
              : selectedIds.length < FANTASY_TEAM_SIZE
              ? `Pick ${FANTASY_TEAM_SIZE - selectedIds.length} more show${FANTASY_TEAM_SIZE - selectedIds.length > 1 ? 's' : ''}`
              : totalSpent > FANTASY_BUDGET
              ? `Over budget by $${totalSpent - FANTASY_BUDGET}`
              : ''}
          </p>
        )}

        {/* Draft Guide link */}
        <div className="text-center mt-8">
          <a
            href="/fantasy/guide"
            className="text-sm text-amber-400/70 hover:text-amber-400 transition-colors"
          >
            Need help picking? Check the Draft Guide &rarr;
          </a>
        </div>
      </div>
    </div>
  );
}
