'use client';

import { useState, useMemo, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import FantasyShowPicker from '@/components/fantasy/FantasyShowPicker';
import FantasyBudgetBar from '@/components/fantasy/FantasyBudgetBar';
import {
  FANTASY_BUDGET,
  DRAFT_DEADLINE,
  isDraftClosed,
  TIEBREAKER_QUESTIONS,
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
  return (
    <Suspense fallback={<div className="min-h-screen bg-surface" />}>
      <FantasyDraftInner />
    </Suspense>
  );
}

function FantasyDraftInner() {
  const searchParams = useSearchParams();
  const leagueFromUrl = searchParams.get('league')?.toLowerCase().trim() || '';
  const [email, setEmail] = useState('');
  const [teamName, setTeamName] = useState('');
  const [leagueName, setLeagueName] = useState('');

  // Pre-fill league from URL param once on mount
  useEffect(() => {
    if (leagueFromUrl) setLeagueName(leagueFromUrl);
  }, [leagueFromUrl]);
  // Dynamic slots: filled picks + one empty "add" slot. No hard cap — budget is the only limit.
  const [picks, setPicks] = useState<string[]>(['']);
  const [tiebreakers, setTiebreakers] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const draftClosed = isDraftClosed();

  const allShows = useMemo(() => {
    return Object.entries(config.shows)
      .map(([id, show]) => ({ id, ...show }))
      .sort((a, b) => b.price - a.price);
  }, []);

  // Best Musical-eligible: Broadway musicals with Tony eligibility
  const bestMusicalCandidates = useMemo(() => {
    return Object.entries(config.shows)
      .filter(([, s]) => s.type === 'musical' && s.category === 'broadway' && s.eligible?.tonys)
      .map(([id, s]) => ({ id, title: s.title }))
      .sort((a, b) => a.title.localeCompare(b.title));
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
    selectedIds.length >= 1 &&
    totalSpent <= FANTASY_BUDGET;

  function handleSelect(showId: string, slotIndex: number) {
    setPicks(prev => {
      const next = [...prev];
      next[slotIndex] = showId;
      // Ensure there's always one empty trailing slot to add more
      if (next.every(Boolean)) next.push('');
      return next;
    });
    setError(null);
  }

  function handleRemove(showId: string) {
    setPicks(prev => {
      const next = prev.filter(id => id !== showId);
      if (next.length === 0 || next.every(Boolean)) next.push('');
      return next;
    });
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
          tiebreakers: Object.keys(tiebreakers).length > 0 ? tiebreakers : null,
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
      <div className="min-h-screen bg-surface text-white">
        <div className="max-w-2xl mx-auto px-4 py-16 text-center">
          <div className="text-6xl mb-6">🎭</div>
          <h1 className="text-3xl font-bold mb-4">You&apos;re In!</h1>
          <p className="text-gray-400 mb-2">
            Your picks are locked in{teamName ? ` as "${teamName}"` : ''}. Picks are final — no changes.
            {leagueName && (
              <> You&apos;ve joined league <a href={`/fantasy/league/${leagueName}`} className="text-brand hover:underline font-semibold">{leagueName}</a>.</>
            )}
          </p>
          <p className="text-gray-400 mb-8">
            Total spent: <span className="text-emerald-400 font-bold">${totalSpent}</span> / ${FANTASY_BUDGET}
          </p>

          <div className="bg-surface-raised/50 rounded-xl p-6 mb-8 text-left">
            <h2 className="text-sm text-gray-500 uppercase tracking-wider mb-3">Your Team</h2>
            <div className="space-y-2">
              {selectedIds.map((id, i) => {
                const show = config.shows[id];
                return (
                  <div key={id} className="flex items-center justify-between">
                    <span className="text-gray-300">{i + 1}. {show?.title}</span>
                    <span className="text-emerald-400 font-mono">${show?.price}</span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <a
              href="/fantasy/leaderboard"
              className="px-6 py-3 bg-brand text-white font-semibold rounded-lg hover:bg-brand-hover transition-colors"
            >
              View Leaderboard
            </a>
          </div>
        </div>
      </div>
    );
  }

  // Draft closed screen
  if (draftClosed) {
    return (
      <div className="min-h-screen bg-surface text-white">
        <div className="max-w-2xl mx-auto px-4 py-16 text-center">
          <h1 className="text-3xl font-bold mb-4">Draft Window Closed</h1>
          <p className="text-gray-400 mb-8">
            The draft deadline has passed. Check the leaderboard to see how teams are performing!
          </p>
          <a
            href="/fantasy/leaderboard"
            className="px-6 py-3 bg-brand text-white font-semibold rounded-lg hover:bg-brand-hover transition-colors"
          >
            View Leaderboard
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface text-white">
      <div className="max-w-2xl mx-auto px-4 py-8 sm:py-12">
        {/* Header */}
        <div className="mb-8">
          <a href="/fantasy" className="text-sm text-gray-500 hover:text-gray-300 transition-colors">
            &larr; Fantasy League
          </a>
          <h1 className="text-2xl sm:text-3xl font-bold mt-2">Draft Your Team</h1>
          <p className="text-gray-400 mt-1">
            Stay under ${FANTASY_BUDGET}. One entry per email.
          </p>
        </div>

        {/* Email + Team info */}
        <div className="space-y-4 mb-6">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Email *</label>
            <input
              type="email"
              className="w-full bg-surface-raised border border-white/10 rounded-lg px-4 py-2.5 text-white placeholder-gray-500 focus:border-brand/50 focus:outline-none transition-colors"
              placeholder="you@email.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
            />
            <p className="text-xs text-gray-600 mt-1">One entry per email, final once submitted — no changes, no redrafts.</p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Team Name</label>
              <input
                type="text"
                className="w-full bg-surface-raised border border-white/10 rounded-lg px-4 py-2.5 text-white placeholder-gray-500 focus:border-brand/50 focus:outline-none transition-colors"
                placeholder="Optional"
                value={teamName}
                onChange={e => setTeamName(e.target.value)}
                maxLength={50}
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">League</label>
              {leagueFromUrl ? (
                <div className="w-full bg-surface-raised border border-brand/30 rounded-lg px-4 py-2.5 text-brand font-mono text-sm">
                  {leagueName}
                  <span className="text-gray-500 font-sans text-xs ml-2">(from invite link)</span>
                </div>
              ) : (
                <input
                  type="text"
                  className="w-full bg-surface-raised border border-white/10 rounded-lg px-4 py-2.5 text-white placeholder-gray-500 focus:border-brand/50 focus:outline-none transition-colors"
                  placeholder="Optional — or create a league first"
                  value={leagueName}
                  onChange={e => setLeagueName(e.target.value)}
                  maxLength={50}
                />
              )}
              {!leagueFromUrl && (
                <p className="text-xs text-gray-600 mt-1">
                  <a href="/fantasy/create-league" className="text-brand/70 hover:text-brand transition-colors">Create a private league →</a>
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Budget Bar */}
        <div className="mb-6">
          <FantasyBudgetBar
            spent={totalSpent}
            budget={FANTASY_BUDGET}
            picksCount={selectedIds.length}
          />
        </div>

        {/* Show Pickers */}
        <div className="space-y-3 mb-8">
          <h2 className="text-sm text-gray-500 uppercase tracking-wider">Your Picks</h2>
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
        <div className="text-xs text-gray-600 mb-6 space-y-1">
          <p>OB = Off-Broadway (no box office points, not Tony-eligible)</p>
        </div>

        {/* Tiebreakers */}
        <div className="space-y-3 mb-8">
          <h2 className="text-sm text-gray-500 uppercase tracking-wider">Tiebreakers</h2>
          <p className="text-xs text-gray-600">Used to break ties on Tony night. Closest answer wins.</p>
          {TIEBREAKER_QUESTIONS.map(q => (
            <div key={q.id}>
              <label className="block text-sm text-gray-400 mb-1">{q.question}</label>
              {q.type === 'show-best-musical' ? (
                <select
                  className="w-full bg-surface-raised border border-white/10 rounded-lg px-4 py-2.5 text-white focus:border-brand/50 focus:outline-none transition-colors"
                  value={tiebreakers[q.id] || ''}
                  onChange={e => setTiebreakers(prev => ({ ...prev, [q.id]: e.target.value }))}
                >
                  <option value="">Select a show…</option>
                  {bestMusicalCandidates.map(s => (
                    <option key={s.id} value={s.id}>{s.title}</option>
                  ))}
                </select>
              ) : (
                <input
                  type={q.type === 'number' ? 'number' : 'text'}
                  className="w-full bg-surface-raised border border-white/10 rounded-lg px-4 py-2.5 text-white placeholder-gray-500 focus:border-brand/50 focus:outline-none transition-colors"
                  placeholder={q.type === 'number' ? 'Your guess' : 'Your answer'}
                  value={tiebreakers[q.id] || ''}
                  onChange={e => setTiebreakers(prev => ({ ...prev, [q.id]: e.target.value }))}
                />
              )}
            </div>
          ))}
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
              ? 'bg-brand text-white hover:bg-brand-hover active:scale-[0.98]'
              : 'bg-surface-overlay text-gray-500 cursor-not-allowed'
          }`}
        >
          {submitting ? 'Submitting...' : `Lock In My Picks ($${totalSpent})`}
        </button>

        {!canSubmit && !submitting && selectedIds.length > 0 && (
          <p className="text-center text-xs text-gray-500 mt-2">
            {!email.includes('@')
              ? 'Enter your email to submit'
              : selectedIds.length < 1
              ? 'Pick at least one show'
              : totalSpent > FANTASY_BUDGET
              ? `Over budget by $${totalSpent - FANTASY_BUDGET}`
              : ''}
          </p>
        )}

        {/* Draft Guide link */}
        <div className="text-center mt-8">
          <a
            href="/fantasy/guide"
            className="text-sm text-brand/70 hover:text-brand transition-colors"
          >
            Need help picking? Check the Draft Guide &rarr;
          </a>
        </div>
      </div>
    </div>
  );
}
