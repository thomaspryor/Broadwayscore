'use client';

import { useState, useMemo, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import FantasyShowPicker from '@/components/fantasy/FantasyShowPicker';
import FantasyShareButton from '@/components/fantasy/FantasyShareButton';
import FantasyBudgetBar from '@/components/fantasy/FantasyBudgetBar';
import {
  FANTASY_BUDGET,
  FANTASY_TEAM_SIZE,
  DRAFT_OPENS,
  draftDeadlineDate,
  EARLY_BIRD_CUTOFF,
  SCORING_START,
  draftMode,
  hasLateEntry,
  TIEBREAKER_QUESTIONS,
  ELIGIBILITY_MARKERS,
} from '@/config/fantasy';
import type { FantasyShow } from '@/config/fantasy';
import { captureEvent } from '@/lib/posthog-events';
import { gaEvent } from '@/lib/analytics/ga-event';

// Import show data at build time (bundled into client)
import fantasyLeagueData from '../../../../data/fantasy-league.json';

type FantasyConfig = {
  _meta: { season: string; draftDeadline: string; budget: number; teamSize: number };
  shows: Record<string, FantasyShow>;
};

const config = fantasyLeagueData as unknown as FantasyConfig;

function shortDate(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function longDate(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

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
  // Practice link for testers (BRO-5487): /fantasy/draft?practice=1.
  const practiceRequested = searchParams.get('practice') === '1';
  const [email, setEmail] = useState('');
  const [teamName, setTeamName] = useState('');
  const [leagueName, setLeagueName] = useState('');

  // Pre-fill league from URL param once on mount
  useEffect(() => {
    if (leagueFromUrl) setLeagueName(leagueFromUrl);
  }, [leagueFromUrl]);
  // Dynamic slots: filled picks + one empty "add" slot, up to FANTASY_TEAM_SIZE.
  const [picks, setPicks] = useState<string[]>(['']);
  const [tiebreakers, setTiebreakers] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<null | { scoringFrom: string | null; pickNotes: Record<string, string>; emailSent: boolean; practice: boolean }>(null);
  const [error, setError] = useState<string | null>(null);

  // The draft window is evaluated on the client after mount so a statically
  // prerendered page can't be stuck on yesterday's state (and so the server
  // and client never disagree during hydration). The API route is the real
  // gate; this only picks which screen to show.
  // Ticks every minute: a form left open past midnight on an opening night
  // must show that show as already open before the player submits.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  // The link's intent decides practice vs real, never the clock alone: a
  // practice form left open past midnight on draft day turns into the
  // "practice is over" screen, not into a real, final entry (BRO-5487).
  const mode = now ? draftMode(practiceRequested, now) : null;
  const practice = mode === 'practice';
  const formOpen = mode === 'practice' || mode === 'open';

  const allShows = useMemo(() => {
    return Object.entries(config.shows)
      .map(([id, show]) => ({ id, ...show }))
      .sort((a, b) => b.price - a.price);
  }, []);

  // Best Musical-eligible: Broadway musicals with Tony eligibility
  const bestMusicalCandidates = useMemo(() => {
    return Object.entries(config.shows)
      .filter(([, s]) => s.type === 'musical' && s.category === 'broadway' && s.eligible?.tonys && !(s as FantasyShow).isRevival)
      .map(([id, s]) => ({ id, title: s.title }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }, []);

  const selectedIds = picks.filter(Boolean);
  const totalSpent = selectedIds.reduce((sum, id) => {
    const show = config.shows[id];
    return sum + (show?.price ?? 0);
  }, 0);
  const remainingBudget = FANTASY_BUDGET - totalSpent;
  const rosterFull = selectedIds.length >= FANTASY_TEAM_SIZE;

  const canSubmit =
    formOpen &&
    !submitting &&
    email.includes('@') &&
    selectedIds.length >= 1 &&
    selectedIds.length <= FANTASY_TEAM_SIZE &&
    totalSpent <= FANTASY_BUDGET;

  function handleSelect(showId: string, slotIndex: number) {
    setPicks(prev => {
      const next = [...prev];
      next[slotIndex] = showId;
      // Keep one empty trailing slot until the roster is full
      if (next.every(Boolean) && next.filter(Boolean).length < FANTASY_TEAM_SIZE) next.push('');
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
          ...(practiceRequested ? { practice: true } : {}),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Something went wrong');
        return;
      }

      captureEvent(practice ? 'fantasy_practice_submitted' : 'fantasy_draft_submitted', {
        picks: selectedIds.length,
        total_cost: totalSpent,
        in_league: !practice && !!leagueName.trim(),
        locked_picks: Array.isArray(data.locked_picks) ? data.locked_picks.length : 0,
        practice,
      });
      gaEvent(practice ? 'fantasy_practice_submitted' : 'fantasy_draft_submitted', {
        picks: selectedIds.length,
        total_cost: totalSpent,
        in_league: !practice && !!leagueName.trim(),
        locked_picks: Array.isArray(data.locked_picks) ? data.locked_picks.length : 0,
        practice,
      });
      setSubmitted({
        scoringFrom: typeof data.scoring_from === 'string' ? data.scoring_from : null,
        pickNotes: data.pick_notes && typeof data.pick_notes === 'object' ? data.pick_notes : {},
        emailSent: data.email_sent === true,
        practice: data.practice === true,
      });
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
          <h1 className="text-3xl font-bold mb-4">{submitted.practice ? 'Practice team saved' : <>You&apos;re In!</>}</h1>
          {submitted.practice && (
            <p className="text-score-tepid mb-4">
              This team doesn&apos;t count and won&apos;t show on the leaderboard. Draft for real from {longDate(DRAFT_OPENS)}.
            </p>
          )}
          <p className="text-gray-400 mb-2">
            {submitted.practice
              ? <>Saved{teamName ? ` as "${teamName}"` : ''}.</>
              : <>Your picks are locked in{teamName ? ` as "${teamName}"` : ''}. Picks are final.</>}
            {leagueName && !submitted.practice && (
              <> You&apos;ve joined league <a href={`/fantasy/league/${encodeURIComponent(leagueName.trim().toLowerCase())}`} className="text-brand hover:underline font-semibold">{leagueName}</a>.</>
            )}
          </p>
          <p className="text-gray-400 mb-2">
            Total spent: <span className="text-emerald-400 font-bold">${totalSpent}</span> / ${FANTASY_BUDGET}
          </p>
          <p className="text-fg-muted text-sm mb-8">
            {submitted.scoringFrom && !submitted.practice && <>Box office counts from the week of {longDate(submitted.scoringFrom)}. </>}
            {submitted.emailSent
              ? <>We emailed a copy of your roster to {email.trim()}.</>
              : submitted.practice ? null : <>Find your team on the leaderboard by searching for {email.trim()}.</>}
          </p>

          <div className="bg-surface-raised/50 rounded-xl p-6 mb-8 text-left">
            <h2 className="text-sm text-fg-muted uppercase tracking-wider mb-3">Your Team</h2>
            <div className="space-y-2">
              {selectedIds.map((id, i) => {
                const show = config.shows[id];
                const note = submitted.pickNotes[id];
                return (
                  <div key={id} className="flex items-center justify-between gap-3">
                    <span className="text-gray-300">
                      {i + 1}. {show?.title}
                      {note && <span className="text-xs text-gray-400 ml-2">{note}</span>}
                    </span>
                    <span className="text-emerald-400 font-mono">${show?.price}</span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            {!submitted.practice && <FantasyShareButton picks={selectedIds} teamName={teamName} />}
            <a
              href={submitted.practice ? '/fantasy' : '/fantasy/leaderboard'}
              className="px-6 py-3 whitespace-nowrap bg-brand text-white font-semibold rounded-lg hover:bg-brand-hover transition-colors"
            >
              {submitted.practice ? 'Back to the game' : 'View Leaderboard'}
            </a>
            {!leagueName && (
              <a
                href="/fantasy/create-league"
                className="px-6 py-3 whitespace-nowrap bg-surface-raised border border-white/10 text-white font-semibold rounded-lg hover:bg-surface-overlay transition-colors"
              >
                Start a league with friends
              </a>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Draft closed screen
  if (mode === 'closed') {
    return (
      <div className="min-h-screen bg-surface text-white">
        <div className="max-w-2xl mx-auto px-4 py-16 text-center">
          <h1 className="text-3xl font-bold mb-4">Draft Window Closed</h1>
          <p className="text-gray-400 mb-8">
            The draft deadline was {longDate(draftDeadlineDate())}. Check the leaderboard to see how teams are performing.
          </p>
          <a
            href="/fantasy/leaderboard"
            className="px-6 py-3 whitespace-nowrap bg-brand text-white font-semibold rounded-lg hover:bg-brand-hover transition-colors"
          >
            View Leaderboard
          </a>
        </div>
      </div>
    );
  }

  // Waiting for the client clock (first paint)
  if (!now) {
    return <div className="min-h-screen bg-surface" />;
  }

  // A practice link after the real draft opened: never show a form that
  // looks like practice but saves for real.
  if (mode === 'practice-over') {
    return (
      <div className="min-h-screen bg-surface text-white">
        <div className="max-w-2xl mx-auto px-4 py-16 text-center">
          <h1 className="text-3xl font-bold mb-4">The practice round is over</h1>
          <p className="text-gray-400 mb-8">The real draft is open. Teams you draft now count, and picks are final.</p>
          <a
            href={`/fantasy/draft${leagueFromUrl ? `?league=${encodeURIComponent(leagueFromUrl)}` : ''}`}
            className="px-6 py-3 whitespace-nowrap bg-brand text-white font-semibold rounded-lg hover:bg-brand-hover transition-colors"
          >
            Draft for real
          </a>
        </div>
      </div>
    );
  }

  // Draft not open yet (a practice link gets the form instead)
  if (!formOpen) {
    return (
      <div className="min-h-screen bg-surface text-white">
        <div className="max-w-2xl mx-auto px-4 py-16 text-center">
          <h1 className="text-3xl font-bold mb-4">The draft opens {longDate(DRAFT_OPENS)}</h1>
          <p className="text-gray-400 mb-8">
            {leagueFromUrl && <>You&apos;re invited to league <span className="text-brand font-semibold">{leagueFromUrl}</span>. Keep this link: it will drop you straight into the league when the draft opens. </>}
            Study the field in the meantime. Every show&apos;s price is in the Draft Guide.
          </p>
          <a
            href="/fantasy/guide"
            className="px-6 py-3 whitespace-nowrap bg-brand text-white font-semibold rounded-lg hover:bg-brand-hover transition-colors"
          >
            Read the Draft Guide
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
          <a href="/fantasy" className="text-sm text-fg-muted hover:text-gray-300 transition-colors">
            &larr; Fantasy League
          </a>
          <h1 className="text-2xl sm:text-3xl font-bold mt-2">{practice ? 'Practice Draft' : 'Draft Your Team'}</h1>
          <p className="text-gray-400 mt-1">
            {practice
              ? <>Pick up to {FANTASY_TEAM_SIZE} shows. Stay under ${FANTASY_BUDGET}. Practice runs until the draft opens on {longDate(DRAFT_OPENS)}.</>
              : <>Pick up to {FANTASY_TEAM_SIZE} shows. Stay under ${FANTASY_BUDGET}. One entry per person. Picks are due {longDate(draftDeadlineDate())} at 11:59pm ET.</>}
          </p>
          {practice && (
            <p role="note" className="mt-4 rounded-lg border border-score-tepid/40 bg-score-tepid-bg px-4 py-3 text-sm text-white">
              Practice round. This team won&apos;t count and won&apos;t show on the leaderboard, so try anything. The real draft opens {longDate(DRAFT_OPENS)}, and your real team is a separate entry.
            </p>
          )}
        </div>

        {/* Email + Team info */}
        <div className="space-y-4 mb-6">
          <div>
            <label htmlFor="fantasy-email" className="block text-sm text-gray-400 mb-1">Email *</label>
            <input
              id="fantasy-email"
              type="email"
              className="w-full bg-surface-raised border border-white/10 rounded-lg px-4 py-2.5 text-white placeholder-fg-placeholder focus:border-brand/50 focus:outline-none transition-colors"
              placeholder="you@email.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
            />
            <p className="text-xs text-fg-muted mt-1">{practice
              ? 'One practice team per email. We email you a copy so you can check it.'
              : 'One entry per person, final once submitted. We email you a copy of your roster and weekly standings.'}</p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="fantasy-team-name" className="block text-sm text-gray-400 mb-1">Team Name</label>
              <input
                id="fantasy-team-name"
                type="text"
                className="w-full bg-surface-raised border border-white/10 rounded-lg px-4 py-2.5 text-white placeholder-fg-placeholder focus:border-brand/50 focus:outline-none transition-colors"
                placeholder="Optional"
                value={teamName}
                onChange={e => setTeamName(e.target.value)}
                maxLength={50}
              />
            </div>
            <div>
              {practice
                ? <p className="block text-sm text-gray-400 mb-1">League</p>
                : <label htmlFor="fantasy-league-name" className="block text-sm text-gray-400 mb-1">League</label>}
              {practice ? (
                <p className="text-xs text-fg-muted pt-1">
                  Leagues start with the real draft.{' '}
                  <a href="/fantasy/create-league" className="text-brand/70 hover:text-brand transition-colors">Create yours now →</a>
                </p>
              ) : leagueFromUrl ? (
                <div className="w-full bg-surface-raised border border-brand/30 rounded-lg px-4 py-2.5 text-brand font-mono text-sm">
                  {leagueName}
                  <span className="text-fg-muted font-sans text-xs ml-2">(from invite link)</span>
                </div>
              ) : (
                <input
                  id="fantasy-league-name"
                  type="text"
                  className="w-full bg-surface-raised border border-white/10 rounded-lg px-4 py-2.5 text-white placeholder-fg-placeholder focus:border-brand/50 focus:outline-none transition-colors"
                  placeholder="Optional, or create a league first"
                  value={leagueName}
                  onChange={e => setLeagueName(e.target.value)}
                  maxLength={50}
                />
              )}
              {!leagueFromUrl && !practice && (
                <p className="text-xs text-fg-muted mt-1">
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
            maxPicks={FANTASY_TEAM_SIZE}
          />
        </div>

        {/* Show Pickers */}
        <div className="space-y-3 mb-4">
          <h2 className="text-sm text-fg-muted uppercase tracking-wider">Your Picks</h2>
          {picks.map((_, index) => (
            <FantasyShowPicker
              key={index}
              shows={allShows}
              selectedIds={picks}
              onSelect={(showId) => handleSelect(showId, index)}
              onRemove={handleRemove}
              remainingBudget={remainingBudget}
              slotIndex={index}
              now={now}
            />
          ))}
          {rosterFull && (
            <p className="text-xs text-fg-muted">Roster full: {FANTASY_TEAM_SIZE} of {FANTASY_TEAM_SIZE} picks. Remove a show to swap it.</p>
          )}
        </div>

        {/* Legend */}
        <div className="text-xs text-gray-400 mb-8 space-y-1">
          <p><span className="text-score-tepid">{ELIGIBILITY_MARKERS.criticScoreLocked}</span> = already open. Reviews are public, so this show earns box office and awards points only (awards only where marked).</p>
          <p>OB = Off-Broadway (no box office points, not Tony-eligible)</p>
          {hasLateEntry()
            ? <p>Picks are due {shortDate(draftDeadlineDate())} at 11:59pm ET. Box office counts from the week you draft (weeks run Monday to Sunday, starting {shortDate(SCORING_START)}), so the sooner you lock in, the more weeks your shows earn.{EARLY_BIRD_CUTOFF >= SCORING_START && <> Draft by {shortDate(EARLY_BIRD_CUTOFF)} and it counts from {shortDate(SCORING_START)}.</>} Critic and audience points count for shows that open after you draft (audience points only while the show has no public audience grade).</p>
            : <p>Picks are due {shortDate(draftDeadlineDate())} at 11:59pm ET. Box office counts for every team from {shortDate(SCORING_START)}. Critic and audience points count for shows that open after you draft (audience points only while the show has no public audience grade).</p>}
        </div>

        {/* Tiebreakers */}
        <div className="space-y-3 mb-8">
          <h2 className="text-sm text-fg-muted uppercase tracking-wider">Tiebreakers</h2>
          <p className="text-xs text-fg-muted">Used to break ties on Tony night. Closest answer wins.</p>
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
                  className="w-full bg-surface-raised border border-white/10 rounded-lg px-4 py-2.5 text-white placeholder-fg-placeholder focus:border-brand/50 focus:outline-none transition-colors"
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
              : 'bg-surface-overlay text-fg-muted opacity-60 cursor-not-allowed'
          }`}
        >
          {submitting ? 'Submitting...' : practice ? `Save Practice Team ($${totalSpent})` : `Lock In My Picks ($${totalSpent})`}
        </button>

        {!canSubmit && !submitting && selectedIds.length > 0 && (
          <p className="text-center text-xs text-fg-muted mt-2">
            {!email.includes('@')
              ? 'Enter your email to submit'
              : selectedIds.length < 1
              ? 'Pick at least one show'
              : selectedIds.length > FANTASY_TEAM_SIZE
              ? `Too many picks: the limit is ${FANTASY_TEAM_SIZE}`
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
