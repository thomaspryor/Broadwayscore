'use client';

import { useState, useMemo, useEffect } from 'react';
import { getOptimizedImageUrl } from '@/lib/images';
import { showFormatTitle } from '@/lib/show-format';

type PreviewShow = {
  id: string;
  title: string;
  price: number;
  type: 'musical' | 'play' | 'special';
  category: 'broadway' | 'off-broadway';
  status: string;
  image: string | null;
  criticScore: number | null;
  audienceGrade: string | null;
};

type Screen = 'landing' | 'drafting' | 'review' | 'submitted';

const BUDGET = 100;

export function FantasyPreviewClient({ shows }: { shows: PreviewShow[] }) {
  useEffect(() => {
    document.body.classList.add('btc-standalone');
    return () => document.body.classList.remove('btc-standalone');
  }, []);
  const [screen, setScreen] = useState<Screen>('landing');
  const [picks, setPicks] = useState<string[]>([]);
  const [filter, setFilter] = useState<'all' | 'broadway' | 'off-broadway'>('all');

  const picksById = useMemo(() => new Set(picks), [picks]);
  const spent = useMemo(
    () => picks.reduce((sum, id) => sum + (shows.find(s => s.id === id)?.price ?? 0), 0),
    [picks, shows],
  );
  const remaining = BUDGET - spent;
  const pickedShows = picks.map(id => shows.find(s => s.id === id)!).filter(Boolean);

  const visibleShows = useMemo(() => {
    return shows
      .filter(s => filter === 'all' ? true : s.category === filter)
      .filter(s => !picksById.has(s.id))
      .sort((a, b) => (b.criticScore ?? 0) - (a.criticScore ?? 0));
  }, [shows, filter, picksById]);

  function togglePick(id: string) {
    const show = shows.find(s => s.id === id)!;
    if (picksById.has(id)) {
      setPicks(picks.filter(p => p !== id));
      return;
    }
    if (spent + show.price > BUDGET) return;
    setPicks([...picks, id]);
  }

  if (screen === 'landing') return <LandingScreen onStart={() => setScreen('drafting')} shows={shows} />;
  if (screen === 'drafting') {
    return (
      <DraftScreen
        shows={visibleShows}
        picks={picks}
        pickedShows={pickedShows}
        spent={spent}
        remaining={remaining}
        filter={filter}
        setFilter={setFilter}
        togglePick={togglePick}
        onBack={() => setScreen('landing')}
        onReview={() => setScreen('review')}
      />
    );
  }
  if (screen === 'review') {
    return (
      <ReviewScreen
        pickedShows={pickedShows}
        spent={spent}
        onBack={() => setScreen('drafting')}
        onSubmit={() => setScreen('submitted')}
        onRemove={togglePick}
      />
    );
  }
  return <SubmittedScreen onRestart={() => { setPicks([]); setScreen('landing'); }} />;
}

// ─── Landing ──────────────────────────────────────────────────────────

function LandingScreen({ onStart, shows }: { onStart: () => void; shows: PreviewShow[] }) {
  return (
    <div className="min-h-screen bg-surface relative overflow-hidden flex flex-col">
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-brand/[0.08] rounded-full blur-[120px]" />
        <div className="absolute bottom-1/4 right-1/4 w-72 h-72 bg-brand/[0.05] rounded-full blur-[100px]" />
      </div>
      <div className="relative z-10 flex-1 flex flex-col items-center justify-center max-w-[480px] mx-auto px-6 py-12 text-center">
        <div className="animate-fade-up" style={{ animationDelay: '0.2s', animationFillMode: 'both' }}>
          <img src="/images/fantasy/bfl-logo.png" alt="BFL" className="w-[160px] mx-auto drop-shadow-[0_0_30px_rgba(212,165,116,0.25)]" />
        </div>
        <div className="animate-fade-up mt-8" style={{ animationDelay: '0.4s', animationFillMode: 'both' }}>
          <span className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-brand/10 border border-brand/20 text-brand text-xs font-semibold tracking-widest uppercase">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
            Tony Season 2025–26
          </span>
        </div>
        <h1 className="animate-fade-up mt-5" style={{ animationDelay: '0.5s', animationFillMode: 'both' }}>
          <span className="block text-[46px] font-black leading-[0.95] tracking-tighter">
            Broadway{' '}
            <span className="text-gradient">Fantasy League</span>
          </span>
        </h1>
        <p className="animate-fade-up mt-5 text-[17px] leading-relaxed text-gray-400 max-w-[360px]" style={{ animationDelay: '0.7s', animationFillMode: 'both' }}>
          Draft shows. Stay under <strong className="text-gray-200">$100</strong>.<br />
          Earn points from critics, audiences, box office, and the Tonys.<br />
          Winner gets <strong className="text-brand">$500 on TodayTix</strong>.
        </p>
        <button
          onClick={onStart}
          className="animate-fade-up mt-8 inline-flex items-center gap-2.5 px-10 py-4 rounded-[14px] bg-brand text-[#09090b] text-[17px] font-bold shadow-[0_4px_24px_rgba(212,165,116,0.35)] hover:shadow-[0_8px_32px_rgba(212,165,116,0.45)] hover:-translate-y-0.5 active:scale-[0.97] transition-all duration-200"
          style={{ animationDelay: '0.9s', animationFillMode: 'both' }}
        >
          Draft Your Team <span>→</span>
        </button>
        <div className="animate-fade-up mt-10 grid grid-cols-3 gap-6" style={{ animationDelay: '1.1s', animationFillMode: 'both' }}>
          <Stat label="Shows" value={shows.length.toString()} />
          <Stat label="Budget" value="$100" />
          <Stat label="Prize" value="$500" />
        </div>
        <div className="animate-fade-up mt-6 flex items-center gap-2.5 px-4 py-2.5 rounded-xl bg-brand/[0.08] border border-brand/15" style={{ animationDelay: '1.3s', animationFillMode: 'both' }}>
          <span className="text-xl">🏆</span>
          <span className="text-sm text-gray-400">Season ends Tony night · One winner · <strong className="text-brand">Free to play</strong></span>
        </div>
        <p className="absolute bottom-4 text-[10px] text-gray-600 uppercase tracking-widest">Preview build · not live</p>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-center">
      <div className="text-[24px] font-extrabold text-brand tracking-tight">{value}</div>
      <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mt-0.5">{label}</div>
    </div>
  );
}

// ─── Draft ────────────────────────────────────────────────────────────

function DraftScreen({
  shows, picks, pickedShows, spent, remaining,
  filter, setFilter, togglePick, onBack, onReview,
}: {
  shows: PreviewShow[];
  picks: string[];
  pickedShows: PreviewShow[];
  spent: number;
  remaining: number;
  filter: 'all' | 'broadway' | 'off-broadway';
  setFilter: (f: 'all' | 'broadway' | 'off-broadway') => void;
  togglePick: (id: string) => void;
  onBack: () => void;
  onReview: () => void;
}) {
  const pctBudget = Math.min(100, (spent / BUDGET) * 100);
  const overBudgetShowCount = shows.filter(s => s.price > remaining).length;

  return (
    <div className="min-h-screen bg-surface flex flex-col pb-[180px]">
      {/* Sticky top: budget */}
      <div className="sticky top-0 z-10 px-5 py-4 border-b border-white/5 bg-surface/95 backdrop-blur-xl">
        <div className="flex items-center justify-between mb-3">
          <button onClick={onBack} className="text-gray-400 text-sm hover:text-white transition-colors p-2 -m-2">← Back</button>
          <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">{picks.length} pick{picks.length !== 1 ? 's' : ''}</span>
          <div className="w-12" />
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-gray-500">
            Budget: <span className="text-white font-bold">${spent}</span>
            <span className="text-gray-600"> / ${BUDGET}</span>
          </span>
          <span className={remaining >= 0 ? 'text-brand font-bold' : 'text-red-400 font-bold'}>
            ${remaining} left
          </span>
        </div>
        <div className="mt-1.5 h-1.5 rounded-full bg-surface-overlay overflow-hidden">
          <div className="h-full rounded-full bg-gradient-to-r from-brand to-brand-hover transition-all duration-300" style={{ width: `${pctBudget}%` }} />
        </div>
      </div>

      {/* Current picks (horizontal scroll) */}
      {pickedShows.length > 0 && (
        <div className="px-5 pt-4 pb-2">
          <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-2">Your team</div>
          <div className="flex gap-2 overflow-x-auto pb-2 -mx-5 px-5 snap-x">
            {pickedShows.map(show => (
              <button
                key={show.id}
                onClick={() => togglePick(show.id)}
                className="flex-shrink-0 w-[110px] snap-start group"
                aria-label={`Remove ${show.title}`}
              >
                <div className="relative w-[110px] h-[110px] rounded-xl overflow-hidden bg-surface-overlay">
                  {show.image ? (
                    <img src={getOptimizedImageUrl(show.image, 'thumbnail')} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-3xl font-black text-white/20">{show.title[0]}</div>
                  )}
                  <div className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/70 flex items-center justify-center text-white text-xs opacity-0 group-hover:opacity-100 transition-opacity">✕</div>
                  <div className="absolute bottom-0 left-0 right-0 px-2 py-1 bg-gradient-to-t from-black/90 to-transparent">
                    <div className="text-[11px] font-bold text-brand">${show.price}</div>
                  </div>
                </div>
                <div className="mt-1 text-[11px] leading-tight text-gray-400 text-left line-clamp-2">{show.title}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Filter toggle */}
      <div className="px-5 pt-3 pb-2">
        <div className="flex gap-1.5 p-1 bg-surface-raised rounded-xl">
          {(['all', 'broadway', 'off-broadway'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`flex-1 py-2 rounded-lg text-xs font-semibold uppercase tracking-wider transition-all ${filter === f ? 'bg-brand text-[#09090b]' : 'text-gray-400 hover:text-white'}`}
            >
              {f === 'all' ? 'All' : f === 'broadway' ? 'Broadway' : 'Off-Bway'}
            </button>
          ))}
        </div>
      </div>

      {/* Show cards */}
      <div className="flex-1 px-5 py-4 max-w-[480px] mx-auto w-full">
        <div className="grid grid-cols-2 gap-3">
          {shows.slice(0, 24).map(show => {
            const unaffordable = show.price > remaining;
            return (
              <button
                key={show.id}
                onClick={() => togglePick(show.id)}
                disabled={unaffordable}
                className={`text-left rounded-[14px] overflow-hidden border-2 transition-all duration-200 ${unaffordable ? 'opacity-40 border-transparent cursor-not-allowed' : 'border-transparent hover:border-brand/40 hover:-translate-y-0.5 active:scale-[0.97]'} bg-surface-raised`}
              >
                <div className="aspect-square relative bg-surface-overlay">
                  {show.image ? (
                    <img src={getOptimizedImageUrl(show.image, 'thumbnail')} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-4xl font-black text-white/20">{show.title[0]}</div>
                  )}
                  <div className="absolute top-2 left-2 px-2 py-0.5 rounded-md bg-black/70 backdrop-blur text-brand text-xs font-bold">${show.price}</div>
                  {show.criticScore != null && (
                    <div className="absolute top-2 right-2 px-1.5 py-0.5 rounded-md bg-black/70 backdrop-blur text-white text-[11px] font-bold">{Math.round(show.criticScore)}</div>
                  )}
                  {show.status === 'closed' && (
                    <div className="absolute bottom-2 left-2 px-2 py-0.5 rounded-md bg-red-500/20 border border-red-500/40 text-red-400 text-[10px] font-bold uppercase">Closed</div>
                  )}
                  {show.category === 'off-broadway' && (
                    <div className="absolute bottom-2 right-2 px-2 py-0.5 rounded-md bg-black/70 backdrop-blur text-white text-[10px] font-bold uppercase">OB</div>
                  )}
                </div>
                <div className="px-3 py-2">
                  <div className="text-[13px] font-bold leading-tight line-clamp-2 min-h-[2.2em]">{show.title}</div>
                </div>
              </button>
            );
          })}
        </div>
        {shows.length > 24 && (
          <p className="text-center text-xs text-gray-500 mt-4">Showing 24 of {shows.length}. Full list in production.</p>
        )}
        {overBudgetShowCount > 0 && shows.length > 0 && (
          <p className="text-center text-xs text-gray-600 mt-3">
            {overBudgetShowCount} shows above your remaining budget are greyed out.
          </p>
        )}
      </div>

      {/* Sticky CTA */}
      <div className="fixed bottom-0 left-0 right-0 z-20 px-5 pb-6 pt-3 bg-gradient-to-t from-surface via-surface to-transparent">
        <div className="max-w-[480px] mx-auto">
          <button
            onClick={onReview}
            disabled={picks.length === 0}
            className={`w-full py-4 rounded-[14px] text-base font-bold transition-all duration-200 ${picks.length > 0 ? 'bg-brand text-[#09090b] shadow-[0_4px_20px_rgba(212,165,116,0.3)] hover:-translate-y-0.5' : 'bg-surface-overlay text-gray-500 cursor-not-allowed'}`}
          >
            {picks.length > 0 ? `Review Team (${picks.length} picks · $${spent}) →` : 'Pick at least one show'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Review ───────────────────────────────────────────────────────────

function ReviewScreen({
  pickedShows, spent, onBack, onSubmit, onRemove,
}: {
  pickedShows: PreviewShow[];
  spent: number;
  onBack: () => void;
  onSubmit: () => void;
  onRemove: (id: string) => void;
}) {
  const [email, setEmail] = useState('');
  const [teamName, setTeamName] = useState('');

  return (
    <div className="min-h-screen bg-surface pb-[140px]">
      <div className="sticky top-0 z-10 px-5 py-4 border-b border-white/5 bg-surface/95 backdrop-blur-xl flex items-center justify-between">
        <button onClick={onBack} className="text-gray-400 text-sm hover:text-white transition-colors">← Edit</button>
        <span className="text-[10px] font-semibold text-brand uppercase tracking-wider">Review</span>
        <div className="w-12" />
      </div>

      <div className="max-w-[480px] mx-auto px-5 py-6">
        <h2 className="text-[28px] font-extrabold tracking-tight mb-1">Your team</h2>
        <p className="text-sm text-gray-500 mb-6">${spent} of $100 spent · {pickedShows.length} picks</p>

        <div className="flex flex-col gap-2.5 mb-6">
          {pickedShows.map((show, i) => (
            <div key={show.id} className="flex items-center gap-3 p-3 rounded-xl bg-surface-raised border border-transparent">
              <div className="w-7 h-7 rounded-full bg-brand/15 flex items-center justify-center text-brand text-xs font-bold">{i + 1}</div>
              {show.image ? (
                <img src={getOptimizedImageUrl(show.image, 'thumbnail')} alt="" className="w-12 h-12 rounded-lg object-cover flex-shrink-0" />
              ) : (
                <div className="w-12 h-12 rounded-lg bg-surface-overlay flex items-center justify-center text-lg font-black text-white/20 flex-shrink-0">{show.title[0]}</div>
              )}
              <div className="flex-1 min-w-0">
                <div className="text-sm font-bold truncate">{show.title}</div>
                <div className="text-xs text-gray-500">{show.category === 'off-broadway' ? 'Off-Broadway' : showFormatTitle(show.type)}</div>
              </div>
              <div className="text-brand font-bold text-sm">${show.price}</div>
              <button onClick={() => onRemove(show.id)} className="text-gray-600 hover:text-red-400 transition-colors p-1" aria-label="Remove">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
              </button>
            </div>
          ))}
        </div>

        <div className="rounded-xl bg-surface-raised p-4 mb-5">
          <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Team name (optional)</label>
          <input
            value={teamName}
            onChange={e => setTeamName(e.target.value)}
            placeholder="The Rushinators"
            className="w-full bg-surface-overlay border border-white/5 rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-brand/50"
          />
          <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5 mt-3">Email</label>
          <input
            value={email}
            onChange={e => setEmail(e.target.value)}
            type="email"
            placeholder="you@example.com"
            className="w-full bg-surface-overlay border border-white/5 rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-brand/50"
          />
          <p className="text-[11px] text-gray-600 mt-2">We email you weekly standings. Never shared.</p>
        </div>

        <p className="text-center text-xs text-gray-600">
          Scoring starts Tony season opening · Final results Tony night · Prize: <strong className="text-brand">$500 on TodayTix</strong>
        </p>
      </div>

      <div className="fixed bottom-0 left-0 right-0 z-20 px-5 pb-6 pt-3 bg-gradient-to-t from-surface via-surface to-transparent">
        <div className="max-w-[480px] mx-auto">
          <button
            onClick={onSubmit}
            disabled={!email.includes('@')}
            className={`w-full py-4 rounded-[14px] text-base font-bold transition-all duration-200 ${email.includes('@') ? 'bg-brand text-[#09090b] shadow-[0_4px_20px_rgba(212,165,116,0.3)] hover:-translate-y-0.5' : 'bg-surface-overlay text-gray-500 cursor-not-allowed'}`}
          >
            Lock In My Team 🏆
          </button>
          <p className="text-center mt-2 text-[11px] text-gray-600">No account needed · You can edit your picks until the deadline</p>
        </div>
      </div>
    </div>
  );
}

// ─── Submitted ────────────────────────────────────────────────────────

function SubmittedScreen({ onRestart }: { onRestart: () => void }) {
  return (
    <div className="min-h-screen bg-surface flex items-center justify-center px-6">
      <div className="max-w-[420px] text-center">
        <div className="mx-auto w-20 h-20 rounded-full bg-brand/15 flex items-center justify-center text-4xl mb-6 animate-fade-up">🏆</div>
        <h2 className="text-[36px] font-black tracking-tighter mb-3 animate-fade-up" style={{ animationDelay: '0.15s', animationFillMode: 'both' }}>You&rsquo;re in.</h2>
        <p className="text-gray-400 mb-8 animate-fade-up" style={{ animationDelay: '0.3s', animationFillMode: 'both' }}>
          Your team is locked in. We&rsquo;ll email weekly standings every Wednesday until Tony night.
        </p>
        <div className="rounded-xl bg-surface-raised p-4 mb-6 text-left animate-fade-up" style={{ animationDelay: '0.45s', animationFillMode: 'both' }}>
          <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-2">What happens next</div>
          <ul className="space-y-2 text-sm text-gray-300">
            <li>→ Weekly email Wednesdays with standings</li>
            <li>→ Points accumulate through Tony night</li>
            <li>→ Winner announced after the ceremony</li>
            <li>→ $500 TodayTix voucher goes to #1</li>
          </ul>
        </div>
        <button
          onClick={onRestart}
          className="text-brand text-sm font-semibold hover:text-brand-hover transition-colors animate-fade-up"
          style={{ animationDelay: '0.6s', animationFillMode: 'both' }}
        >
          Start over →
        </button>
      </div>
    </div>
  );
}
