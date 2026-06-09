'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import type { BeatTheCriticsData, BeatTheCriticsCategoryData, ActorNominee } from './page';
import type { SerializedTonyShow } from '@/lib/data-tony-predictions';
import { ScoreBadge } from '@/components/show-cards';
import { SUBSCRIBED_KEY_PREFIX } from '@/hooks/useFormspreeSubscribed';

// ─── Types ───

type Screen = 'landing' | 'picking' | 'reveal' | 'tier-complete' | 'results';

interface CriticPanelist {
  name: string;
  outlets: string[];
  initials: string;
  bio: string;
  // picks[categoryTitle] populated once critics submit; null = TBD
  picks?: Record<string, string>;
}

// Named critics — picks populated after they respond; shown as TBD until then.
const CRITICS: CriticPanelist[] = [
  { name: 'Dan Rubins', outlets: ['Slant Magazine', 'TheaterMania'], initials: 'DR', bio: 'Theater critic. Host of The Present Stage podcast.',
    picks: {
      'Best Musical': 'The Lost Boys',
      'Best Play': 'Liberation',
      'Best Revival of a Musical': 'Cats: The Jellicle Ball',
      'Best Revival of a Play': 'Death of a Salesman',
      'Best Actor in a Musical': 'Joshua Henry',
      'Best Actress in a Musical': 'Marla Mindelle',
      'Best Actor in a Play': 'John Lithgow',
      'Best Actress in a Play': 'Lesley Manville',
      'Best Featured Actor in a Musical': 'Ben Levi Ross',
      'Best Featured Actress in a Musical': 'Nichelle Lewis',
      'Best Featured Actor in a Play': 'Alden Ehrenreich',
      'Best Featured Actress in a Play': 'Laurie Metcalf',
      'Best Direction of a Musical': 'Cats: The Jellicle Ball',
      'Best Direction of a Play': 'Death of a Salesman',
      'Best Original Score': 'Two Strangers (Carry A Cake Across New York)',
      'Best Book of a Musical': 'Schmigadoon!',
      'Best Choreography': 'Cats: The Jellicle Ball',
      'Best Orchestrations': 'Schmigadoon!',
    },
  },
  { name: 'Naveen Kumar', outlets: ['WaPo', 'NYTimes'], initials: 'NK', bio: 'Former theater critic for The Washington Post. Work also appears in The New York Times, Variety, and Town & Country.',
    picks: {
      'Best Musical': 'The Lost Boys',
      'Best Play': 'Liberation',
      'Best Revival of a Musical': 'Cats: The Jellicle Ball',
      'Best Revival of a Play': 'Oedipus',
      'Best Actor in a Musical': 'Joshua Henry',
      'Best Actress in a Musical': 'Caissie Levy',
      'Best Actor in a Play': 'John Lithgow',
      'Best Actress in a Play': 'Lesley Manville',
      'Best Featured Actor in a Musical': 'André De Shields',
      'Best Featured Actress in a Musical': 'Shoshana Bean',
      'Best Featured Actor in a Play': 'Ruben Santiago-Hudson',
      'Best Featured Actress in a Play': 'Laurie Metcalf',
      'Best Direction of a Musical': 'The Lost Boys',
      'Best Direction of a Play': 'Death of a Salesman',
      'Best Original Score': 'The Lost Boys',
      'Best Book of a Musical': 'The Lost Boys',
      'Best Choreography': 'Cats: The Jellicle Ball',
      'Best Orchestrations': 'The Lost Boys',
    },
  },
  { name: 'Matthew Wexler', outlets: ['1 Minute Critic'], initials: 'MW', bio: 'Founder of 1 Minute Critic. Theater critic and member of the American Theatre Critics Association.',
    picks: {
      'Best Musical': 'The Lost Boys',
      'Best Play': 'Liberation',
      'Best Revival of a Musical': 'Ragtime',
      'Best Revival of a Play': 'Death of a Salesman',
      'Best Actor in a Musical': 'Joshua Henry',
      'Best Actress in a Musical': 'Caissie Levy',
      'Best Actor in a Play': 'John Lithgow',
      'Best Actress in a Play': 'Susannah Flood',
      'Best Featured Actor in a Musical': 'Ali Louis Bourzgui',
      'Best Featured Actress in a Musical': 'Shoshana Bean',
      'Best Featured Actor in a Play': 'Ruben Santiago-Hudson',
      'Best Featured Actress in a Play': 'Laurie Metcalf',
      'Best Book of a Musical': 'Titanique',
      'Best Original Score': 'The Lost Boys',
      'Best Orchestrations': 'Cats: The Jellicle Ball',
      'Best Choreography': 'Cats: The Jellicle Ball',
      'Best Direction of a Musical': 'The Lost Boys',
      'Best Direction of a Play': 'Liberation',
    },
  },
];

// Picks are hidden until after the ceremony — critics' picks revealed June 8, 2026
const PICKS_REVEAL_DATE = new Date('2026-06-08T00:00:00Z');
const PICKS_REVEALED = Date.now() >= PICKS_REVEAL_DATE.getTime();

function criticHasPicks(): boolean {
  return CRITICS.some(c => c.picks && Object.keys(c.picks).length > 0);
}

// ─── Helpers ───

function getTonyPredictionPick(nominees: SerializedTonyShow[]): string {
  const scored = [...nominees].filter(n => n.blendedScore != null || n.compositeScore != null);
  if (scored.length === 0) return nominees[0]?.title ?? '';
  scored.sort((a, b) => (b.blendedScore ?? b.compositeScore ?? 0) - (a.blendedScore ?? a.compositeScore ?? 0));
  return scored[0].title;
}

function getCriticPick(critic: CriticPanelist, category: string): string | null {
  return critic.picks?.[category] ?? null;
}

function getActorCriticPick(critic: CriticPanelist, category: string): string | null {
  return critic.picks?.[category] ?? null;
}

function getCrowdPercentages(nominees: SerializedTonyShow[]): number[] {
  if (nominees.length === 0) return [];
  const scores = nominees.map(n => n.blendedScore ?? n.compositeScore ?? 50);
  const total = scores.reduce((a, b) => a + b, 0);
  if (total === 0) return nominees.map(() => Math.round(100 / nominees.length));
  const pcts = scores.map(s => Math.round((s / total) * 100));
  const diff = 100 - pcts.reduce((a, b) => a + b, 0);
  if (pcts.length > 0) pcts[0] += diff;
  return pcts;
}

function getActorCrowdPercentages(nominees: ActorNominee[]): number[] {
  if (nominees.length === 0) return [];
  const scores = nominees.map(n => n.showScore ?? 50);
  const total = scores.reduce((a, b) => a + b, 0);
  if (total === 0) return nominees.map(() => Math.round(100 / nominees.length));
  const pcts = scores.map(s => Math.round((s / total) * 100));
  const diff = 100 - pcts.reduce((a, b) => a + b, 0);
  if (pcts.length > 0) pcts[0] += diff;
  return pcts;
}

function seededShuffle<T>(arr: T[], seed: number): T[] {
  const shuffled = [...arr];
  let s = seed;
  for (let i = shuffled.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    const j = ((s >>> 0) % (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function getShowImagePath(show: SerializedTonyShow): string | null {
  if (!show.thumbnailPath) return null;
  return show.thumbnailPath;
}

function getActorImagePath(nominee: ActorNominee): string | null {
  if (!nominee.thumbnailPath) return null;
  return nominee.thumbnailPath;
}

function categoryHasNominees(cat: BeatTheCriticsCategoryData): boolean {
  return (cat.nominees?.length ?? 0) > 0 || (cat.actorNominees?.length ?? 0) > 0;
}

// ─── Components ───

function BtcBrand({ size = 'default' }: { size?: 'default' | 'small' }) {
  if (size === 'small') {
    return <span className="text-[9px] font-bold uppercase tracking-widest text-brand">Broadway Scorecard</span>;
  }
  return (
    <div className="leading-tight text-center">
      <div className="text-base font-extrabold tracking-tight">
        <span className="text-white">Broadway</span><span className="text-gradient">Scorecard</span><span className="text-[10px] text-gray-500 font-normal align-super ml-0.5">&trade;</span>
      </div>
    </div>
  );
}

function ShowPoster({ show, size = 'sm' }: { show: SerializedTonyShow; size?: 'xs' | 'sm' | 'md' }) {
  const [imgError, setImgError] = useState(false);
  const dims = size === 'md' ? 'w-12 h-12' : size === 'xs' ? 'w-8 h-8' : 'w-11 h-11';
  const radius = size === 'xs' ? 'rounded-md' : 'rounded-lg';
  const imgPath = getShowImagePath(show);
  if (imgError || !imgPath) {
    return (<div className={`${dims} ${radius} bg-surface-overlay flex items-center justify-center text-sm font-extrabold text-white/30 flex-shrink-0`}>{show.title.charAt(0)}</div>);
  }
  return (<img src={imgPath} alt={show.title} className={`${dims} ${radius} object-cover flex-shrink-0 bg-surface-overlay`} onError={() => setImgError(true)} />);
}

function ActorPoster({ nominee }: { nominee: ActorNominee }) {
  const parts = nominee.name.split(' ').filter(Boolean);
  const initials = parts.length >= 3
    ? parts[0][0] + parts[1][0] + parts[parts.length - 1][0]
    : parts.map(p => p[0]).join('');
  return (<div className="w-11 h-11 rounded-lg bg-surface-overlay flex items-center justify-center text-xs font-extrabold text-white/30 flex-shrink-0">{initials.toUpperCase()}</div>);
}

function shortTitle(title: string): string {
  return title.replace(' (Carry a Cake Across New York)', '');
}

function ph(event: string, props?: Record<string, unknown>) {
  try {
    (window as unknown as { posthog?: { capture: (e: string, p?: Record<string, unknown>) => void } }).posthog?.capture(event, props);
  } catch {}
}

function NomineeCard({ show, selected, onSelect }: { show: SerializedTonyShow; selected: boolean; onSelect: () => void }) {
  return (
    <button onClick={onSelect} className={`w-full flex items-center gap-3.5 p-3.5 rounded-[14px] text-left transition-all duration-200 ${selected ? 'bg-[#ff1368]/[0.06] border-2 border-[#ff1368] shadow-[0_0_20px_rgba(255,19,104,0.1)]' : 'bg-surface-raised border-2 border-transparent hover:bg-surface-overlay hover:border-white/10'}`}>
      <ShowPoster show={show} />
      <div className="flex-1 min-w-0">
        <div className="text-[15px] font-bold line-clamp-2 leading-snug">{shortTitle(show.title)}</div>
        <div className="text-xs text-gray-500">{show.venue}</div>
      </div>
      <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-all duration-200 ${selected ? 'border-[#ff1368]' : 'border-white/20'}`}>
        {selected && <div className="w-2.5 h-2.5 rounded-full bg-[#ff1368] animate-scale-in" />}
      </div>
    </button>
  );
}

function ActorNomineeCard({ nominee, selected, onSelect }: { nominee: ActorNominee; selected: boolean; onSelect: () => void }) {
  return (
    <button onClick={onSelect} className={`w-full flex items-center gap-3.5 p-3.5 rounded-[14px] text-left transition-all duration-200 ${selected ? 'bg-[#ff1368]/[0.06] border-2 border-[#ff1368] shadow-[0_0_20px_rgba(255,19,104,0.1)]' : 'bg-surface-raised border-2 border-transparent hover:bg-surface-overlay hover:border-white/10'}`}>
      <ActorPoster nominee={nominee} />
      <div className="flex-1 min-w-0">
        <div className="text-[15px] font-bold line-clamp-2 leading-snug">{nominee.name}</div>
        <div className="text-xs text-gray-500">{nominee.showTitle}</div>
      </div>
      <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-all duration-200 ${selected ? 'border-[#ff1368]' : 'border-white/20'}`}>
        {selected && <div className="w-2.5 h-2.5 rounded-full bg-[#ff1368] animate-scale-in" />}
      </div>
    </button>
  );
}

function CrowdBar({ label, pct, isUserPick, variant, score }: { label: string; pct: number; isUserPick: boolean; variant: 'rose' | 'brand' | 'muted'; score?: number | null }) {
  const barRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const timer = setTimeout(() => { if (barRef.current) barRef.current.style.width = `${pct}%`; }, 600); return () => clearTimeout(timer); }, [pct]);
  const bgColor = variant === 'rose' ? 'bg-[#ff1368]' : variant === 'brand' ? 'bg-brand' : 'bg-gray-500';
  return (
    <div className="mb-2.5">
      <div className="flex justify-between text-xs mb-1">
        <span className="font-semibold">{label}{isUserPick && <span className="text-[#ff1368] text-[10px] font-semibold ml-1">(Your pick)</span>}</span>
        <span className="text-white font-bold">{pct}%</span>
      </div>
      <div className="h-2 rounded bg-surface-overlay overflow-hidden"><div ref={barRef} className={`h-full rounded ${bgColor} transition-all duration-1000 ease-out`} style={{ width: 0 }} /></div>
    </div>
  );
}

// ─── Main Client Component ───

export function BeatTheCriticsClient({ data }: { data: BeatTheCriticsData }) {
  useEffect(() => {
    document.body.classList.add('btc-standalone');
    try {
      const saved = localStorage.getItem('btc-picks');
      const savedSlugs = localStorage.getItem('btc-pick-slugs');
      if (saved) setPicks(JSON.parse(saved));
      if (savedSlugs) setPickSlugs(JSON.parse(savedSlugs));
      if (localStorage.getItem('btc-email-submitted') === '1') setEmailSubmitted(true);
    } catch {}
    return () => document.body.classList.remove('btc-standalone');
  }, []);
  const [expandedCriticIdx, setExpandedCriticIdx] = useState<number | null>(null);
  const [picksRevealed, setPicksRevealed] = useState(PICKS_REVEALED);
  const [screen, setScreen] = useState<Screen>('landing');
  const [currentTierIdx, setCurrentTierIdx] = useState(0);
  const [currentCatIdx, setCurrentCatIdx] = useState(0);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [pickSlugs, setPickSlugs] = useState<Record<string, string>>({});
  const [shuffleSeed] = useState(() => Math.floor(Math.random() * 1000000));
  const [emailSubmitted, setEmailSubmitted] = useState(false);
  const [emailSubmitting, setEmailSubmitting] = useState(false);
  const [emailError, setEmailError] = useState('');
  const [timeLeft, setTimeLeft] = useState({ days: 0, hours: 0, minutes: 0, seconds: 0 });
  const [countdownExpired, setCountdownExpired] = useState(() => Date.now() >= new Date('2026-06-08T00:00:00Z').getTime());
  const [pickStats, setPickStats] = useState<{ totalSubmissions: number; picks: Record<string, Record<string, number>> } | null>(null);
  useEffect(() => {
    const ceremony = new Date('2026-06-08T00:00:00Z'); // 8 PM ET June 8
    const tick = () => {
      const diff = ceremony.getTime() - Date.now();
      if (diff <= 0) { setTimeLeft({ days: 0, hours: 0, minutes: 0, seconds: 0 }); setCountdownExpired(true); return; }
      setTimeLeft({
        days: Math.floor(diff / 86400000),
        hours: Math.floor((diff % 86400000) / 3600000),
        minutes: Math.floor((diff % 3600000) / 60000),
        seconds: Math.floor((diff % 60000) / 1000),
      });
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (PICKS_REVEALED) return;
    const ms = PICKS_REVEAL_DATE.getTime() - Date.now();
    if (ms <= 0) { setPicksRevealed(true); return; }
    const id = setTimeout(() => setPicksRevealed(true), ms);
    return () => clearTimeout(id);
  }, []);
  useEffect(() => {
    fetch('/api/beat-the-critics/pick-stats')
      .then(r => r.json())
      .then(data => setPickStats(data))
      .catch(() => {});
  }, []);
  const resultsTrackedRef = useRef(false);
  useEffect(() => {
    if (screen === 'results' && !resultsTrackedRef.current) {
      resultsTrackedRef.current = true;
      ph('btc_results_reached', { total_picks_made: totalPicksMade, entries_earned: entriesEarned });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);

  const emailRef = useRef<HTMLInputElement>(null);
  const emailSubmittingRef = useRef(false);
  const currentTier = data.tiers[currentTierIdx];
  const currentCategory = currentTier?.categories[currentCatIdx];
  const totalCategoriesInTier = currentTier?.categories.length ?? 0;
  const allCompletedPicks = Object.entries(picks);
  const entriesEarned = data.tiers.filter(tier =>
    tier.categories.filter(categoryHasNominees).every(cat => picks[cat.title])
  ).length;
  const totalCategories = data.tiers.flatMap(t => t.categories).filter(categoryHasNominees).length;
  const totalPicksMade = data.tiers.flatMap(t => t.categories).filter(c => categoryHasNominees(c) && picks[c.title]).length;

  const handlePick = useCallback((category: string, title: string, slug: string) => {
    setPicks(prev => { const next = { ...prev, [category]: title }; try { localStorage.setItem('btc-picks', JSON.stringify(next)); } catch {} return next; });
    setPickSlugs(prev => { const next = { ...prev, [category]: slug }; try { localStorage.setItem('btc-pick-slugs', JSON.stringify(next)); } catch {} return next; });
  }, []);

  const handleLockIn = useCallback(() => {
    if (!currentCategory || !picks[currentCategory.title]) return;
    ph('btc_pick_locked_in', {
      tier: currentTier?.key,
      tier_name: currentTier?.name,
      category: currentCategory.title,
      pick: picks[currentCategory.title],
      total_picks_made: totalPicksMade,
    });
    setScreen('reveal');
  }, [currentCategory, picks, currentTier, totalPicksMade]);

  const findNextNonEmptyCategory = useCallback((fromCatIdx: number): number | null => {
    for (let i = fromCatIdx + 1; i < totalCategoriesInTier; i++) {
      if (categoryHasNominees(currentTier?.categories[i])) return i;
    }
    return null;
  }, [currentTier, totalCategoriesInTier]);

  const hasNextTier = currentTierIdx + 1 < data.tiers.length && data.tiers[currentTierIdx + 1].categories.some(categoryHasNominees);

  const handleNextCategory = useCallback(() => {
    const nextIdx = findNextNonEmptyCategory(currentCatIdx);
    if (nextIdx !== null) {
      setCurrentCatIdx(nextIdx);
      setScreen('picking');
    } else if (hasNextTier) {
      // Stay on reveal — tier transition buttons handle this
    } else {
      setScreen('results');
    }
  }, [currentCatIdx, findNextNonEmptyCategory, hasNextTier]);

  const handleNextTier = useCallback(() => {
    const nextTierIdx = currentTierIdx + 1;
    if (nextTierIdx < data.tiers.length) {
      setCurrentTierIdx(nextTierIdx);
      const firstCatIdx = data.tiers[nextTierIdx].categories.findIndex(categoryHasNominees);
      setCurrentCatIdx(firstCatIdx >= 0 ? firstCatIdx : 0);
      setScreen('picking');
    }
  }, [currentTierIdx, data.tiers]);

  const handleEmailSave = useCallback(async () => {
    if (emailSubmittingRef.current) return;
    const email = emailRef.current?.value?.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      setEmailError('Please enter a valid email address.');
      return;
    }
    setEmailError('');
    emailSubmittingRef.current = true;
    setEmailSubmitting(true);
    try {
      const res = await fetch('/api/beat-the-critics/send-picks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, picks, ceremonyYear: data.season.ceremonyYear }),
      });
      if (!res.ok) {
        setEmailError('Something went wrong. Please try again.');
        return;
      }
      // Subscribe to newsletter + persist user data
      const formId = process.env.NEXT_PUBLIC_FORMSPREE_SUBSCRIBER_FORM_ID;
      if (formId) {
        await fetch(`https://formspree.io/f/${formId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, source: 'beat-the-critics' }),
        }).catch(() => {});
      }
      try {
        const existing = JSON.parse(localStorage.getItem('bsc_user_data') || '{}');
        existing.email = email;
        localStorage.setItem('bsc_user_data', JSON.stringify(existing));
        localStorage.setItem(`${SUBSCRIBED_KEY_PREFIX}broadway`, 'true');
        localStorage.setItem('btc-email-submitted', '1');
      } catch { /* localStorage unavailable */ }
      ph('btc_email_submitted', { total_picks_made: totalPicksMade, entries_earned: entriesEarned });
      setEmailSubmitted(true);
    } catch {
      setEmailError('Network error. Please try again.');
    } finally {
      emailSubmittingRef.current = false;
      setEmailSubmitting(false);
    }
  }, [picks, data.season.ceremonyYear, totalPicksMade, entriesEarned]);

  const shareText = useCallback(() => {
    const lines: string[] = [];
    for (const tier of data.tiers) {
      const tierPicks = tier.categories.filter(categoryHasNominees).filter(cat => picks[cat.title]);
      if (tierPicks.length === 0) continue;
      lines.push(`\n${tier.name}:`);
      for (const cat of tierPicks) {
        lines.push(`${cat.title.replace('Best ', '')}: ${picks[cat.title]}`);
      }
    }
    return `My Tony Award Picks 🏆 (${entriesEarned} ${entriesEarned === 1 ? 'entry' : 'entries'})${lines.join('\n')}\n\nMake your picks: broadwayscorecard.com/beat-the-critics`;
  }, [data.tiers, picks, entriesEarned]);

  const handleShare = useCallback(async () => {
    const text = shareText();
    if (navigator.share) {
      ph('btc_shared', { method: 'native' });
      try { await navigator.share({ title: 'My Tony Picks — Beat the Critics', text }); } catch { /* user cancelled */ }
    } else {
      ph('btc_shared', { method: 'clipboard' });
      await navigator.clipboard.writeText(text);
      alert('Copied to clipboard!');
    }
  }, [shareText]);

  const handleShareX = useCallback(() => {
    ph('btc_shared', { method: 'x' });
    const text = encodeURIComponent(shareText());
    window.open(`https://x.com/intent/tweet?text=${text}`, '_blank');
  }, [shareText]);

  const goToScreen = useCallback((s: Screen) => { setScreen(s); window.scrollTo(0, 0); }, []);

  // ─── Landing Screen ───
  if (screen === 'landing') {
    return (
      <div className="min-h-screen w-full bg-surface relative overflow-x-hidden flex flex-col">
        <div className="absolute inset-0 pointer-events-none"><div className="absolute top-0 left-1/4 w-96 h-96 bg-[#ff1368]/[0.06] rounded-full blur-[120px]" /><div className="absolute bottom-1/4 right-1/4 w-72 h-72 bg-brand/[0.04] rounded-full blur-[100px]" /></div>
        <div className="relative z-10 flex-1 flex flex-col items-center justify-start w-full max-w-[480px] mx-auto px-6 pt-8 pb-10 text-center">
          <div className="animate-fade-up" style={{ animationDelay: '0.2s', animationFillMode: 'both' }}><BtcBrand /></div>
          <div className="animate-fade-up mt-6" style={{ animationDelay: '0.4s', animationFillMode: 'both' }}>
            <span className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-[#ff1368]/10 border border-[#ff1368]/20 text-[#ff1368] text-xs font-semibold tracking-widest uppercase">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
              Tony Awards {data.season.ceremonyYear}
            </span>
          </div>
          <h1 className="animate-fade-up mt-4" style={{ animationDelay: '0.5s', animationFillMode: 'both' }}>
            <span className="block text-[44px] font-black leading-[0.95] tracking-tighter">Beat{' '}<span className="bg-gradient-to-br from-brand to-[#ff1368] bg-clip-text text-transparent">the Critics</span><sup className="text-sm font-bold text-gray-500 align-super ml-0.5">&trade;</sup></span>
          </h1>
          <div className="animate-fade-up mt-5 flex flex-col items-center gap-2" style={{ animationDelay: '0.7s', animationFillMode: 'both' }}>
            <p className="text-base leading-snug text-gray-300 text-center">Pick Tony winners.</p>
            <p className="text-base leading-snug text-gray-300 text-center">Compete against top critics.</p>
            <div className="mt-1 px-5 py-2.5 rounded-full bg-amber-500/10 border border-amber-500/25 text-amber-400 text-sm font-semibold text-center max-w-xs w-full">
              🎁 Beat a critic — win a <strong>$200 TodayTix gift card</strong>
            </div>
            <div className="flex items-center justify-center gap-1.5 text-[14px] text-gray-600 font-semibold">Prize sponsored by <img src="/todaytix-logo.svg" alt="TodayTix" className="h-[14px] opacity-80" /></div>
            <a href="/beat-the-critics/rules" className="text-[10px] text-gray-600 hover:text-gray-400 transition-colors">Official Rules</a>
          </div>

          {/* Critic grid */}
          <div className="w-full mt-4">
            <div className="animate-fade-up text-[10px] font-bold uppercase tracking-widest text-gray-600 mb-2 text-center" style={{ animationDelay: '0.85s', animationFillMode: 'both' }}>Your Competition</div>
            <div className="grid grid-cols-3 gap-2">
              {CRITICS.map((c, i) => {
                const expanded = expandedCriticIdx === i;
                return (
                  <button key={i} onClick={() => setExpandedCriticIdx(expanded ? null : i)} className="animate-fade-up rounded-xl bg-surface-raised ring-1 ring-white/5 p-3 text-left w-full transition-all duration-200 hover:ring-white/10 active:scale-[0.98]" style={{ animationDelay: `${0.88 + i * 0.1}s`, animationFillMode: 'both' }}>
                    <div className="w-8 h-8 rounded-full bg-surface-overlay flex items-center justify-center text-xs font-black text-gray-300 mb-2">{c.initials}</div>
                    <div className="text-[12px] font-bold leading-tight">{c.name}</div>
                    <div className="text-[9px] text-brand font-semibold mt-0.5 leading-tight">{c.outlets.join(' · ')}</div>
                    <div className={`text-[10px] text-gray-500 mt-1 leading-snug ${expanded ? '' : 'line-clamp-3'}`}>{c.bio}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <p className="animate-fade-up text-[13px] text-gray-500 mt-4 max-w-[300px] text-center leading-relaxed" style={{ animationDelay: '0.88s', animationFillMode: 'both' }}>Only 1 round required to enter — do all 4 for your best shot at beating the critics.</p>
          <button onClick={() => { ph('btc_started'); setCurrentTierIdx(0); const firstIdx = data.tiers[0]?.categories.findIndex(c => categoryHasNominees(c)) ?? 0; setCurrentCatIdx(firstIdx >= 0 ? firstIdx : 0); goToScreen('picking'); }} className="animate-fade-up mt-4 inline-flex items-center gap-2.5 px-10 py-4 rounded-[14px] bg-gradient-to-br from-[#ff1368] to-[#d4106a] text-white text-[17px] font-bold shadow-[0_4px_24px_rgba(255,19,104,0.35)] hover:shadow-[0_8px_32px_rgba(255,19,104,0.45)] hover:-translate-y-0.5 active:scale-[0.97] transition-all duration-200" style={{ animationDelay: '0.9s', animationFillMode: 'both' }}>Make Your Picks &rarr;</button>
          {!countdownExpired && (
            <div className="animate-fade-up mt-5 flex flex-col items-center gap-2" style={{ animationDelay: '0.95s', animationFillMode: 'both' }}>
              <div className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest">until the Tonys</div>
              <div className="flex items-center justify-center gap-4">
                {([{ v: timeLeft.days, l: 'Days' }, { v: timeLeft.hours, l: 'Hrs' }, { v: timeLeft.minutes, l: 'Min' }, { v: timeLeft.seconds, l: 'Sec' }] as const).map(({ v, l }) => (
                  <div key={l} className="text-center">
                    <div className="text-2xl font-bold text-gray-400 tabular-nums leading-none">{String(v).padStart(2, '0')}</div>
                    <div className="text-[9px] font-semibold text-gray-600 uppercase tracking-widest mt-1">{l}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ─── Picking Screen ───
  if (screen === 'picking' && currentCategory) {
    const isActor = !!currentCategory.isActorCategory;
    const selectedTitle = picks[currentCategory.title];
    const catsWithNominees = currentTier.categories.filter(categoryHasNominees);
    const currentProgressIdx = catsWithNominees.findIndex(c => c.title === currentCategory.title);

    // Get the right nominees list
    const showNominees = isActor ? [] : seededShuffle(currentCategory.nominees, shuffleSeed + currentCatIdx);
    const actorNominees = isActor ? seededShuffle(currentCategory.actorNominees ?? [], shuffleSeed + currentCatIdx) : [];

    return (
      <div className="min-h-screen bg-surface flex flex-col">
        <div className="sticky top-0 z-10 px-5 py-4 flex items-center justify-between border-b border-white/5 bg-surface/90 backdrop-blur-xl">
          <button onClick={() => { let prevIdx: number | null = null; for (let i = currentCatIdx - 1; i >= 0; i--) { if (categoryHasNominees(currentTier.categories[i])) { prevIdx = i; break; } } if (prevIdx !== null) setCurrentCatIdx(prevIdx); else if (currentTierIdx > 0) { setCurrentTierIdx(currentTierIdx - 1); const prevTier = data.tiers[currentTierIdx - 1]; const lastCat = prevTier.categories.length - 1; setCurrentCatIdx(lastCat); setScreen('reveal'); } else goToScreen('landing'); }} className="text-gray-400 text-sm hover:text-white transition-colors p-2 -m-2">&larr; Back</button>
          <div className="flex gap-1.5">{catsWithNominees.map((_, i) => (<div key={i} className={`h-2 rounded transition-all duration-300 ${i < currentProgressIdx ? 'w-2 bg-[#ff1368]' : i === currentProgressIdx ? 'w-5 bg-[#ff1368] shadow-[0_0_8px_rgba(255,19,104,0.5)]' : 'w-2 bg-surface-overlay'}`} />))}</div>
          <div className="flex items-center gap-1 text-[11px] font-bold text-gray-400">
            <span>🏆</span>
            <span className="tabular-nums">{totalPicksMade}<span className="text-gray-600">/{totalCategories}</span></span>
          </div>
        </div>
        <div className="px-5 py-6 max-w-[480px] mx-auto w-full">
          <div className="inline-flex px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider mb-3 bg-brand/15 text-brand">{currentTier.label} &middot; {currentTier.name}</div>
          <h2 className="text-[28px] font-extrabold tracking-tight mb-1.5">{currentCategory.title}</h2>
          <p className="text-sm text-gray-500 mb-7">Tap your pick.</p>
          <div className="flex flex-col gap-2.5">
            {isActor
              ? actorNominees.map((nom) => (<ActorNomineeCard key={nom.name + nom.showSlug} nominee={nom} selected={selectedTitle === nom.name} onSelect={() => handlePick(currentCategory.title, nom.name, nom.showSlug)} />))
              : showNominees.map((show) => (<NomineeCard key={show.slug} show={show} selected={selectedTitle === show.title} onSelect={() => handlePick(currentCategory.title, show.title, show.slug)} />))
            }
          </div>
          <div className="mt-8 pb-10">
            <div className="text-center mb-4 text-[11px] text-amber-400/60 font-semibold">
              Beat a critic &mdash; chance to win a <span className="text-amber-400/80">$200 TodayTix gift card</span>
            </div>
            <button onClick={handleLockIn} disabled={!selectedTitle} className={`w-full py-4 rounded-[14px] text-base font-bold transition-all duration-200 ${selectedTitle ? 'bg-gradient-to-br from-[#ff1368] to-[#d4106a] text-white shadow-[0_4px_20px_rgba(255,19,104,0.3)] hover:-translate-y-0.5' : 'bg-surface-overlay text-gray-500 cursor-not-allowed'}`}>{selectedTitle ? 'Lock In: ' + shortTitle(selectedTitle) + ' \u2192' : 'Lock In Pick'}</button>
            <p className="text-center mt-2.5 text-xs text-gray-500">Not sure? Go with your gut!</p>
            <p className="text-center mt-1 text-xs"><a href="https://demo.broadwayscorecard.com/tony-awards/predictions/2025-2026" target="_blank" rel="noopener noreferrer" className="text-amber-400 hover:text-amber-300 transition-colors">Check our Predictions &rarr;</a></p>
          </div>
        </div>
      </div>
    );
  }

  // ─── Reveal Screen ───
  if (screen === 'reveal' && currentCategory) {
    const isActor = !!currentCategory.isActorCategory;
    const userPick = picks[currentCategory.title];
    const hasMoreCatsInTier = findNextNonEmptyCategory(currentCatIdx) !== null;

    // Show categories: full reveal with CriticScore + critics + crowd
    // Actor categories: critics only (no Tony prediction)
    const nominees = isActor ? [] : [...currentCategory.nominees].sort((a, b) => (b.compositeScore ?? 0) - (a.compositeScore ?? 0));
    const actorNominees = isActor ? (currentCategory.actorNominees ?? []) : [];
    const tonyPredictionPick = isActor ? '' : getTonyPredictionPick(nominees);
    const picksAvailable = picksRevealed && criticHasPicks();
    const criticPicks = CRITICS.map(c => isActor ? getActorCriticPick(c, currentCategory.title) : getCriticPick(c, currentCategory.title));
    const rawCategoryVotes = pickStats?.picks[currentCategory.title] ?? {};
    // Include the user's own pick so they always see themselves in the breakdown
    const categoryVotes: Record<string, number> = { ...rawCategoryVotes };
    if (userPick) categoryVotes[userPick] = (categoryVotes[userPick] ?? 0) + 1;
    const totalCategoryVotes = Object.values(categoryVotes).reduce((a, b) => a + b, 0);
    const crowdPcts = isActor ? [] : (() => {
      if (totalCategoryVotes === 0) return nominees.map(() => 0);
      const counts = nominees.map(n => categoryVotes[n.title] ?? 0);
      const pcts = counts.map(c => Math.round((c / totalCategoryVotes) * 100));
      const diff = 100 - pcts.reduce((a, b) => a + b, 0);
      if (pcts.length > 0) pcts[0] += diff;
      return pcts;
    })();
    const actorCrowdPcts = isActor ? (() => {
      if (totalCategoryVotes === 0) return actorNominees.map(() => 0);
      const counts = actorNominees.map(n => categoryVotes[n.name] ?? 0);
      const pcts = counts.map(c => Math.round((c / totalCategoryVotes) * 100));
      const diff = 100 - pcts.reduce((a, b) => a + b, 0);
      if (pcts.length > 0) pcts[0] += diff;
      return pcts;
    })() : [];
    const tonyPredictionPickShow = isActor ? undefined : nominees.find(n => n.title === tonyPredictionPick);
    const matchesTonyPrediction = isActor ? false : userPick === tonyPredictionPick;
    const criticMatches = picksAvailable ? criticPicks.filter(p => p === userPick).length : 0;

    return (
      <div className="min-h-screen bg-surface flex flex-col">
        <div className="sticky top-0 z-10 px-5 py-4 flex items-center justify-between border-b border-white/5 bg-surface/90 backdrop-blur-xl">
          <button onClick={() => goToScreen('picking')} className="text-gray-400 text-sm hover:text-white transition-colors p-2 -m-2">&larr; Back</button>
          <div className="flex gap-1.5">{currentTier.categories.filter(categoryHasNominees).map((_, i) => (<div key={i} className={`h-2 rounded transition-all duration-300 ${i <= currentTier.categories.filter(categoryHasNominees).findIndex(c => c.title === currentCategory.title) ? 'w-2 bg-[#ff1368]' : 'w-2 bg-surface-overlay'}`} />))}</div>
          <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Reveal</div>
        </div>
        <div className="px-5 py-6 max-w-[480px] mx-auto w-full">
          <div className="text-center mb-8 animate-fade-up" style={{ animationFillMode: 'both' }}><h2 className="text-2xl font-extrabold">{currentCategory.title}</h2><p className="text-sm text-gray-400 mt-1">Here&apos;s what the experts picked</p></div>
          <div className="rounded-xl mb-2 px-3.5 py-3 flex items-center gap-2.5 bg-[#ff1368]/[0.06] ring-1 ring-[#ff1368]/15 animate-fade-up" style={{ animationDelay: '0.15s', animationFillMode: 'both' }}>
            <div className="w-[116px] shrink-0 leading-tight min-w-0">
              <div className="text-xs font-bold text-[#ff1368]">Your Pick</div>
              {picksAvailable && <div className="text-[9px] font-semibold text-gray-500 tracking-wider truncate">{criticMatches} of {CRITICS.length} agree</div>}
            </div>
            {!isActor && (() => { const pickShow = nominees.find(n => n.title === userPick); return pickShow ? <ShowPoster show={pickShow} size="xs" /> : null; })()}
            {isActor && (() => { const pickActor = actorNominees.find(n => n.name === userPick); return pickActor ? <ActorPoster nominee={pickActor} /> : null; })()}
            <div className="min-w-0 flex-1">
              <div className="text-sm font-bold truncate">{userPick}</div>
              {isActor && (() => { const picked = actorNominees.find(n => n.name === userPick); return picked ? <div className="text-[10px] text-gray-500 truncate">{picked.showTitle}</div> : null; })()}
            </div>
            {!isActor && currentTierIdx === 0 && matchesTonyPrediction && <span className="shrink-0 text-xs font-black uppercase tracking-wider px-3 py-1.5 rounded-lg bg-green-500/25 text-green-300">Match!</span>}
          </div>

          {/* Critics Panel */}
          <div className="mb-6">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">
              Critics Panel
              {!isActor && currentTierIdx === 0 && <span className="text-[10px] font-semibold uppercase tracking-wider">Powered by <span className="text-brand">CriticScore</span></span>}
              <div className="flex-1 h-px bg-white/5" />
            </div>

            {/* Tony Prediction row — Tier 1 (Big Four) only */}
            {!isActor && currentTierIdx === 0 && (
              <div className={`rounded-xl mb-2 px-3.5 py-3 flex items-center gap-2.5 animate-slide-in ${matchesTonyPrediction ? 'bg-green-500/[0.08] ring-1 ring-green-500/20' : 'bg-surface-raised ring-1 ring-white/5'}`} style={{ animationDelay: '0.3s', animationFillMode: 'both' }}>
                <div className="w-[116px] shrink-0 leading-tight min-w-0">
                  <div className="text-xs font-bold text-brand">Broadway Scorecard</div>
                  <div className="text-[9px] font-semibold text-gray-500 tracking-wider">Tony Prediction</div>
                </div>
                {tonyPredictionPickShow && <ShowPoster show={tonyPredictionPickShow} size="xs" />}
                <div className="text-sm font-bold truncate flex-1 min-w-0">{tonyPredictionPick}</div>
                {matchesTonyPrediction && <span className="shrink-0 text-xs font-black uppercase tracking-wider px-3 py-1.5 rounded-lg bg-green-500/25 text-green-300">Match!</span>}
              </div>
            )}

            {/* Critic rows — same layout whether picks are available or TBD */}
            {CRITICS.map((critic, i) => {
              const pick = picksAvailable ? criticPicks[i] : null;
              const isMatch = pick !== null && userPick === pick;
              const pickShow = !isActor && pick ? nominees.find(n => n.title === pick) : undefined;
              const actorPick = isActor && pick ? actorNominees.find(n => n.name === pick) : undefined;
              return (
                <div key={i} className={`rounded-xl mb-2 px-3.5 py-3 flex items-center gap-2.5 animate-slide-in ${isMatch ? 'bg-green-500/[0.06] ring-1 ring-green-500/15' : 'bg-surface-raised ring-1 ring-white/5'}`} style={{ animationDelay: `${(isActor ? 0.3 : 0.4) + i * 0.1}s`, animationFillMode: 'both' }}>
                  <div className="w-[148px] shrink-0 flex items-center gap-2 min-w-0 overflow-hidden">
                    <div className="w-7 h-7 rounded-full bg-surface-overlay flex items-center justify-center text-[10px] font-bold text-gray-400 shrink-0">{critic.initials}</div>
                    <div className="leading-tight min-w-0 overflow-hidden">
                      <div className="text-xs font-bold truncate">{critic.name}</div>
                      <div className="text-[10px] text-gray-500 truncate">{critic.outlets.join(' · ')}</div>
                    </div>
                  </div>
                  {pick !== null && (pickShow ? <ShowPoster show={pickShow} size="xs" /> : actorPick ? <ActorPoster nominee={actorPick} /> : null)}
                  <div className="min-w-0 flex-1">
                    {pick === null
                      ? <div className="text-sm text-gray-500">Revealed June 8</div>
                      : <><div className="text-sm font-bold truncate">{shortTitle(pick)}</div>
                         {actorPick && <div className="text-[10px] text-gray-500 truncate">{actorPick.showTitle}</div>}</>
                    }
                  </div>
                  {isMatch && (
                    <span className="shrink-0 text-xs font-black uppercase tracking-wider px-3 py-1.5 rounded-lg bg-green-500/25 text-green-300">Match!</span>
                  )}
                </div>
              );
            })}
          </div>

          {/* How Others Voted — actor categories */}
          {isActor && actorNominees.length > 0 && (
            <div className="mb-7 animate-fade-up" style={{ animationDelay: '0.8s', animationFillMode: 'both' }}>
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-gray-500 mb-1">How Others Voted<div className="flex-1 h-px bg-white/5" /></div>
              <div className="text-[10px] text-gray-600 mb-3">{totalCategoryVotes > 0 ? `${totalCategoryVotes.toLocaleString()} pick${totalCategoryVotes === 1 ? '' : 's'} so far` : 'No votes yet — be the first!'}</div>
              {totalCategoryVotes > 0 && actorNominees.map((actor, i) => (<CrowdBar key={actor.name} label={actor.name} pct={actorCrowdPcts[i] ?? 0} isUserPick={actor.name === userPick} variant={actor.name === userPick ? 'rose' : i === 0 ? 'brand' : 'muted'} />))}
            </div>
          )}
          {/* How Others Voted — show categories */}
          {!isActor && (
            <div className="mb-7 animate-fade-up" style={{ animationDelay: '0.8s', animationFillMode: 'both' }}>
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-gray-500 mb-1">How Others Voted<div className="flex-1 h-px bg-white/5" /></div>
              <div className="text-[10px] text-gray-600 mb-3">{totalCategoryVotes > 0 ? `${totalCategoryVotes.toLocaleString()} pick${totalCategoryVotes === 1 ? '' : 's'} so far` : 'No votes yet — be the first!'}</div>
              {totalCategoryVotes > 0 && nominees.map((show, i) => (<CrowdBar key={show.slug} label={show.title} pct={crowdPcts[i] ?? 0} isUserPick={show.title === userPick} variant={show.title === userPick ? 'rose' : i === 0 ? 'brand' : 'muted'} />))}
            </div>
          )}
          {/* Bottom button \u2014 inline, no fixed positioning */}
          <div className="mt-8 pb-10 flex flex-col gap-2.5">
            {hasMoreCatsInTier ? (
              <button onClick={handleNextCategory} className="w-full py-4 rounded-[14px] text-base font-bold bg-gradient-to-br from-[#ff1368] to-[#d4106a] text-white shadow-[0_4px_20px_rgba(255,19,104,0.3)] hover:-translate-y-0.5 transition-all">
                Keep Going &rarr;
                {(() => { const nextIdx = findNextNonEmptyCategory(currentCatIdx); const nextCat = nextIdx !== null ? currentTier.categories[nextIdx] : null; const catsWN = currentTier.categories.filter(categoryHasNominees); const nextP = nextCat ? catsWN.findIndex(c => c.title === nextCat.title) + 1 : 0; return nextCat ? (<span className="block text-xs font-medium opacity-80 mt-0.5">Next: {nextCat.title} ({nextP} of {catsWN.length})</span>) : null; })()}
              </button>
            ) : (
              <button onClick={() => goToScreen(hasNextTier ? 'tier-complete' : 'results')} className="w-full py-4 rounded-[14px] text-base font-bold bg-gradient-to-br from-[#ff1368] to-[#d4106a] text-white shadow-[0_4px_20px_rgba(255,19,104,0.3)] hover:-translate-y-0.5 transition-all">
                {hasNextTier ? 'Complete Round →' : 'See My Ballot →'}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ─── Tier Complete Celebration ───
  if (screen === 'tier-complete') {
    const tierJustCompleted = currentTier;
    const completedCats = tierJustCompleted?.categories.filter(categoryHasNominees) ?? [];
    const tierNumber = currentTierIdx + 1;
    const nextTier = hasNextTier ? data.tiers[currentTierIdx + 1] : null;

    return (
      <div className="min-h-screen bg-surface flex flex-col items-center justify-center px-6">
        <div className="max-w-[420px] w-full text-center animate-fade-up" style={{ animationFillMode: 'both' }}>
          <div className="text-6xl mb-4">🏆</div>
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-[#ff1368]/10 border border-[#ff1368]/20 text-[#ff1368] text-sm font-bold uppercase tracking-wider mb-5">
            Round {tierNumber} Complete!
          </div>
          <h2 className="text-[32px] font-black tracking-tight mb-2">
            {tierJustCompleted?.name} Complete
          </h2>
          <p className="text-gray-400 text-base mb-3">
            You picked all {completedCats.length} categories in {tierJustCompleted?.name}.
          </p>
          {currentTierIdx === 0 && (
            <div className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-green-500/10 border border-green-500/20 text-green-400 text-sm font-semibold mb-3">
              🎟️ You&apos;re now eligible for the prize draw!
            </div>
          )}
          <div className="flex justify-center gap-2 mb-8">
            {data.tiers.map((t, i) => (
              <div key={t.key} className={`h-2.5 w-8 rounded-full transition-all ${i <= currentTierIdx ? 'bg-[#ff1368]' : 'bg-surface-overlay'}`} />
            ))}
          </div>
          <p className="text-sm text-gray-500 mb-8">
            {entriesEarned} of {data.tiers.length} rounds complete
          </p>

          {nextTier ? (
            <>
              <button onClick={() => { ph('btc_tier_completed', { tier: currentTier?.key, tier_name: currentTier?.name, tier_num: currentTierIdx + 1, action: 'continue' }); handleNextTier(); }} className="w-full py-4 rounded-[14px] text-base font-bold bg-gradient-to-br from-[#ff1368] to-[#d4106a] text-white shadow-[0_4px_24px_rgba(255,19,104,0.35)] hover:-translate-y-0.5 transition-all mb-3">
                Continue to {nextTier.name} &rarr;
                <span className="block text-xs font-medium opacity-80 mt-0.5">Round {tierNumber + 1} of {data.tiers.length}</span>
              </button>
              <button onClick={() => { ph('btc_tier_completed', { tier: currentTier?.key, tier_name: currentTier?.name, tier_num: currentTierIdx + 1, action: 'skip_to_results' }); goToScreen('results'); }} className="w-full py-3.5 rounded-[14px] text-sm font-semibold border border-white/10 text-gray-400 hover:border-brand hover:text-brand transition-all">
                {currentTierIdx === 0 ? 'Submit & Enter Prize Draw' : 'Save & Share My Ballot'}
              </button>
            </>
          ) : (
            <button onClick={() => goToScreen('results')} className="w-full py-4 rounded-[14px] text-base font-bold bg-gradient-to-br from-[#ff1368] to-[#d4106a] text-white shadow-[0_4px_24px_rgba(255,19,104,0.35)] hover:-translate-y-0.5 transition-all">
              See My Ballot &rarr;
              <span className="block text-xs font-medium opacity-80 mt-0.5">All {data.tiers.length} rounds complete!</span>
            </button>
          )}
        </div>
      </div>
    );
  }

  // ─── Results Screen ───
  return (
    <div className="min-h-screen bg-surface flex flex-col">
      <div className="sticky top-0 z-10 px-5 py-4 flex items-center justify-between border-b border-white/5 bg-surface/90 backdrop-blur-xl"><button onClick={() => goToScreen('reveal')} className="text-gray-400 text-sm hover:text-white transition-colors p-2 -m-2">&larr; Back</button><div className="text-xs font-bold">Your Ballot</div><div /></div>
      <div className="flex-1 px-5 py-4 max-w-[480px] mx-auto w-full flex flex-col items-center">

        {/* Email / Submission — FIRST, above the fold */}
        {emailSubmitted ? (
          <div className="w-full max-w-[380px] px-4 py-3 rounded-2xl bg-green-500/[0.06] border border-green-500/15 text-center animate-fade-up flex items-center gap-3">
            <div className="text-2xl shrink-0">🎭</div>
            <div className="text-left">
              <h3 className="text-sm font-bold text-green-400">You&apos;re entered!</h3>
              <p className="text-xs text-gray-400 mt-0.5">After the June 8 ceremony, we&apos;ll email you your results.</p>
            </div>
          </div>
        ) : (
          <div className="w-full max-w-[380px] p-5 rounded-2xl bg-gradient-to-br from-[#ff1368]/[0.06] to-brand/[0.04] border border-[#ff1368]/10 animate-fade-up">
            <h3 className="text-base font-bold">Submit your picks</h3>
            <p className="text-sm text-gray-400 mt-1.5 mb-1">Enter your email to officially enter. After the ceremony on June 8, we&apos;ll email you with your results. You&apos;ll also be added to our mailing list — unsubscribe anytime.</p>
            <p className="text-sm font-semibold text-amber-400 mb-4">🎟️ Beat a critic and you&apos;ll be entered in the <strong>$200 TodayTix prize draw</strong>.</p>
            <div className="flex gap-2 mb-3">
              <input ref={emailRef} type="email" placeholder="you@email.com" className="flex-1 px-4 py-3.5 rounded-xl border border-white/10 bg-surface-raised text-white text-sm outline-none focus:border-[#ff1368] transition-colors placeholder:text-gray-500" />
              <button onClick={handleEmailSave} disabled={emailSubmitting} className="px-6 py-3.5 rounded-xl bg-[#ff1368] text-white text-sm font-bold hover:bg-[#e6115e] transition-colors whitespace-nowrap disabled:opacity-60">
                {emailSubmitting ? 'Submitting...' : 'Submit'}
              </button>
            </div>
            {emailError && <p className="text-red-400 text-xs mb-2">{emailError}</p>}
          </div>
        )}

        {/* Share buttons */}
        {emailSubmitted ? (
          <div className="w-full max-w-[380px] mt-3 animate-fade-up">
            <button onClick={handleShare} className="w-full py-3 rounded-[14px] text-sm font-bold bg-gradient-to-br from-[#ff1368] to-[#d4106a] text-white shadow-[0_4px_24px_rgba(255,19,104,0.35)] hover:shadow-[0_8px_32px_rgba(255,19,104,0.45)] hover:-translate-y-0.5 active:scale-[0.97] transition-all duration-200 flex items-center justify-center gap-2.5">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8M16 6l-4-4-4 4M12 2v13" /></svg>
              Share My Picks
            </button>
            <div className="flex gap-2.5 mt-2 justify-center">
              <button onClick={handleShareX} className="flex items-center gap-1.5 px-5 py-2.5 rounded-[10px] text-sm font-semibold border border-white/10 bg-surface-raised text-white hover:border-brand hover:-translate-y-0.5 transition-all">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>
                Post
              </button>
              <button onClick={handleShare} className="flex items-center gap-1.5 px-5 py-2.5 rounded-[10px] text-sm font-semibold border border-white/10 bg-surface-raised text-white hover:border-brand hover:-translate-y-0.5 transition-all">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="12" cy="12" r="5" /><circle cx="18" cy="6" r="1.5" fill="currentColor" /></svg>
                Story
              </button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2.5 mt-4 animate-fade-up">
            {[{ label: 'Share', action: handleShare, icon: <path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8M16 6l-4-4-4 4M12 2v13" /> }, { label: 'Post', action: handleShareX, icon: <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" fill="currentColor" stroke="none" /> }, { label: 'Story', action: handleShare, icon: <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="12" cy="12" r="5" /><circle cx="18" cy="6" r="1.5" fill="currentColor" /></> }].map(btn => (<button key={btn.label} onClick={btn.action} className="flex items-center gap-1.5 px-4 py-2.5 rounded-[10px] text-sm font-semibold border border-white/10 bg-surface-raised text-white hover:border-brand hover:-translate-y-0.5 transition-all"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">{btn.icon}</svg>{btn.label}</button>))}
          </div>
        )}

        {/* Ballot Card — collapsed by default */}
        <div className="w-full max-w-[380px] mt-3 rounded-[20px] overflow-hidden bg-surface-raised border border-white/10 shadow-[0_20px_60px_rgba(0,0,0,0.5)] animate-fade-up" style={{ animationDelay: '0.2s', animationFillMode: 'both' }}>
          <div className="px-6 pt-4 pb-3 bg-gradient-to-br from-[#ff1368]/10 to-brand/[0.06] border-b border-white/5"><div className="text-center"><BtcBrand size="small" /><div className="text-[18px] font-black tracking-tight mt-2">My Tony Picks</div><div className="text-xs text-gray-400">Beat the Critics &middot; {data.season.ceremonyYear}</div></div></div>
          <div className="px-5 py-3">
            {data.tiers.map(tier => {
              const tierPicks = tier.categories.filter(categoryHasNominees).filter(cat => picks[cat.title]);
              if (tierPicks.length === 0) return null;
              return (
                <div key={tier.key}>
                  <div className="text-[9px] font-bold uppercase tracking-wider text-gray-600 mt-2 first:mt-0 mb-0.5 text-center">{tier.name}</div>
                  {tierPicks.map(cat => (<div key={cat.title} className="flex items-center justify-between py-1.5 border-b border-white/5 last:border-b-0"><div className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 shrink-0 mr-2">{cat.title.replace('Best ', '').replace('Revival of a ', 'Revival \u00b7 ').replace('Featured ', 'Feat. ')}</div><div className="text-xs font-bold text-right">{picks[cat.title]}</div></div>))}
                </div>
              );
            })}
            {allCompletedPicks.length === 0 && (<div className="py-4 text-center text-gray-500 text-sm">No picks made yet</div>)}
          </div>
          <div className="px-6 py-4 bg-[#ff1368]/[0.04] border-t border-white/5 text-center"><div className="text-sm font-bold text-[#ff1368]">Can you Beat the Critics?</div><div className="text-xs text-gray-500 mt-1">broadwayscorecard.com/beat-the-critics</div></div>
        </div>
      </div>
    </div>
  );
}
