'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { ScoreBadge } from '@/components/show-cards';
import type { BeatTheCriticsData, BeatTheCriticsCategoryData } from './page';
import type { SerializedTonyShow } from '@/lib/data-tony-predictions';

// ─── Types ───

type Screen = 'landing' | 'picking' | 'reveal' | 'results';

interface CriticPanelist {
  name: string;
  outlet: string;
  initials: string;
}

const CRITICS: CriticPanelist[] = [
  { name: 'Dan Rubins', outlet: 'BroadwayRadio', initials: 'DR' },
  { name: 'Michael Cusumano', outlet: 'TheaterMania', initials: 'MC' },
  { name: 'Emlyn Whatley', outlet: 'Vulture', initials: 'EW' },
];

// ─── Helpers ───

/** Generate a mock CriticScore pick — highest-scored nominee */
function getCriticScorePick(nominees: SerializedTonyShow[]): string {
  const scored = nominees.filter(n => n.compositeScore != null);
  if (scored.length === 0) return nominees[0]?.title ?? '';
  scored.sort((a, b) => (b.blendedScore ?? b.compositeScore ?? 0) - (a.blendedScore ?? a.compositeScore ?? 0));
  return scored[0].title;
}

/** Generate mock critic picks (deterministic, seeded by category title) */
function getCriticPicks(category: string, nominees: SerializedTonyShow[]): string[] {
  if (nominees.length === 0) return [];
  // Distribute critics across top nominees deterministically
  const seed = category.length;
  return CRITICS.map((_, i) => {
    const idx = (seed + i) % Math.min(nominees.length, 3);
    return nominees[idx]?.title ?? nominees[0]?.title ?? '';
  });
}

/** Generate mock crowd percentages */
function getCrowdPercentages(nominees: SerializedTonyShow[]): number[] {
  if (nominees.length === 0) return [];
  // Weight by score, fallback to equal distribution
  const scores = nominees.map(n => n.blendedScore ?? n.compositeScore ?? 50);
  const total = scores.reduce((a, b) => a + b, 0);
  const pcts = scores.map(s => Math.round((s / total) * 100));
  // Ensure they sum to 100
  const diff = 100 - pcts.reduce((a, b) => a + b, 0);
  if (pcts.length > 0) pcts[0] += diff;
  return pcts;
}

function getShowImagePath(show: SerializedTonyShow): string | null {
  if (!show.thumbnailPath) return null;
  // External CDN URLs (e.g. Contentful) — use as-is
  if (show.thumbnailPath.startsWith('http')) return show.thumbnailPath;
  // Local images — convert thumbnail to poster (same directory, better aspect ratio)
  return show.thumbnailPath.replace('/thumbnail.webp', '/poster.webp');
}

// ─── Components ───

function TodayTixLogo({ className = '', white = false }: { className?: string; white?: boolean }) {
  return (
    <svg className={className} width="115" height="24" viewBox="0 0 115 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g clipPath="url(#ttx-clip)">
        <path fillRule="evenodd" clipRule="evenodd" d="M45.7049 0V19.0044H41.366V16.8581C40.3193 18.4212 38.6889 19.3107 36.5657 19.3107C32.6584 19.3107 29.5496 15.7859 29.5496 11.4639C29.5496 7.14186 32.6584 3.64839 36.5657 3.64839C38.6889 3.64839 40.3193 4.53786 41.366 6.10096V0H45.7049ZM41.366 11.4639C41.366 9.38033 39.7041 7.75457 37.581 7.75457C35.4893 7.75457 33.796 9.40992 33.796 11.4639C33.796 13.5474 35.4893 15.1732 37.581 15.1732C39.7041 15.1732 41.366 13.5788 41.366 11.4639ZM28.4749 11.4952C28.4749 15.9704 25.0586 19.3107 20.6288 19.3107C16.1675 19.3107 12.7827 15.9704 12.7827 11.4952C12.7827 7.02002 16.1675 3.64839 20.6288 3.64839C25.0586 3.64839 28.4749 7.02002 28.4749 11.4952ZM17.0273 11.4952C17.0273 13.5788 18.5651 15.1732 20.6271 15.1732C22.6576 15.1732 24.2268 13.5788 24.2268 11.4952C24.2268 9.349 22.6576 7.7859 20.6271 7.7859C18.5668 7.7859 17.0273 9.349 17.0273 11.4952ZM63.0573 19.0044V3.95475H58.7183V6.10096C57.6716 4.53786 56.0412 3.64839 53.918 3.64839C50.0107 3.64839 46.9019 7.14186 46.9019 11.4639C46.9019 15.7859 50.0107 19.3107 53.918 19.3107C56.0412 19.3107 57.6716 18.4212 58.7183 16.8581V19.0044H63.0573ZM54.9333 7.75457C57.0565 7.75457 58.7183 9.38033 58.7183 11.4639C58.7183 13.5788 57.0565 15.1732 54.9333 15.1732C52.8416 15.1732 51.1483 13.5474 51.1483 11.4639C51.1483 9.40992 52.8416 7.75457 54.9333 7.75457ZM75.667 3.95474L72.3136 12.752L68.9584 3.95474H64.2822L70.0978 17.7789L67.2966 24H71.9431L80.3449 3.95474H75.667ZM97.4386 19.0044V3.95474H93.0997V19.0044H97.4386ZM108.914 11.2184L114.393 19.0044H109.161L106.298 14.9278L103.436 19.0044H98.2669L103.714 11.2498L98.6059 3.95474H103.838L106.33 7.51088L108.914 11.2184ZM91.7611 3.953V8.06092H88.0355V12.8129C88.0355 14.4369 89.1434 15.1419 90.6515 15.1419C91.0202 15.1419 91.4204 15.1123 91.7594 15.02V19.0061C91.1757 19.1593 90.2828 19.2515 89.6677 19.2515C86.0993 19.2515 83.6983 16.9208 83.6983 12.8755V8.06266H80.1038L81.825 3.95474H83.6983V0.0382913H88.0373V3.953H91.7611ZM11.6573 8.0731V3.96519H7.93349V0.0487369H3.59453V3.96519H1.72125L0 8.0731H3.59453V12.886C3.59453 16.9312 5.99555 19.262 9.56387 19.262C10.179 19.262 11.0719 19.1697 11.6556 19.0165V15.0322C11.3166 15.1245 10.9164 15.154 10.5477 15.154C9.03963 15.154 7.93174 14.4491 7.93174 12.8251V8.0731H11.6573ZM110.132 8.36205C111.577 8.36205 112.778 7.16797 112.778 5.72672C112.778 4.3168 111.577 3.12097 110.132 3.12097C108.687 3.12097 107.487 4.3168 107.487 5.72672C107.487 7.16623 108.685 8.36205 110.132 8.36205Z" fill={white ? 'white' : 'url(#ttx-grad)'} />
      </g>
      <defs>
        <linearGradient id="ttx-grad" x1="0" y1="18.6" x2="90.28" y2="-0.12" gradientUnits="userSpaceOnUse">
          <stop stopColor="#F70614" />
          <stop offset="1" stopColor="#FB2CDF" />
        </linearGradient>
        <clipPath id="ttx-clip">
          <rect width="114.393" height="24" fill="white" />
        </clipPath>
      </defs>
    </svg>
  );
}

function CoBrand({ size = 'default' }: { size?: 'default' | 'small' }) {
  if (size === 'small') {
    return (
      <div className="flex items-center justify-center gap-3">
        <TodayTixLogo className="h-3 w-auto" white />
        <span className="text-[9px] text-gray-500">&times;</span>
        <span className="text-[9px] font-bold uppercase tracking-widest text-brand">Broadway Scorecard</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3.5">
      <TodayTixLogo className="h-5 w-auto" white />
      <div className="w-px h-7 bg-white/10" />
      <div className="leading-tight">
        <div className="text-[11px] font-bold text-gray-400 tracking-tight">Broadway Scorecard</div>
        <div className="text-[8px] font-semibold text-gray-500 tracking-wider">CriticScore&trade;</div>
      </div>
    </div>
  );
}

function ShowPoster({ show, size = 'sm' }: { show: SerializedTonyShow; size?: 'sm' | 'md' }) {
  const [imgError, setImgError] = useState(false);
  const dims = size === 'md' ? 'w-14 h-20' : 'w-[52px] h-[72px]';

  const imgPath = getShowImagePath(show);

  if (imgError || !imgPath) {
    return (
      <div className={`${dims} rounded-lg bg-surface-overlay flex items-center justify-center text-xl font-extrabold text-white/30 flex-shrink-0`}>
        {show.title.charAt(0)}
      </div>
    );
  }

  return (
    <img
      src={imgPath}
      alt={show.title}
      className={`${dims} rounded-lg object-cover flex-shrink-0 bg-surface-overlay`}
      onError={() => setImgError(true)}
    />
  );
}

function NomineeCard({
  show,
  selected,
  onSelect,
}: {
  show: SerializedTonyShow;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`
        w-full flex items-center gap-3.5 p-3.5 rounded-[14px] text-left transition-all duration-200
        ${selected
          ? 'bg-[#ff1368]/[0.06] border-2 border-[#ff1368] shadow-[0_0_20px_rgba(255,19,104,0.1)]'
          : 'bg-surface-raised border-2 border-transparent hover:bg-surface-overlay hover:border-white/10'
        }
      `}
    >
      <ShowPoster show={show} />
      <div className="flex-1 min-w-0">
        <div className="text-[15px] font-bold truncate">{show.title}</div>
        <div className="text-[11px] text-gray-500 flex items-center gap-2">
          <span>{show.venue}</span>
          <span className="text-[#ff1368] font-semibold">TodayTix &rarr;</span>
        </div>
      </div>
      <div className="relative flex-shrink-0">
        <ScoreBadge
          score={show.compositeScore}
          size="sm"
          reviewCount={show.reviewCount}
          status={show.status}
          showCrown
        />
        {selected && (
          <div className="absolute -top-1 -right-1 w-[18px] h-[18px] rounded-full bg-[#ff1368] flex items-center justify-center animate-scale-in">
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="white" strokeWidth="2">
              <path d="M2.5 6l2.5 2.5 4.5-5" />
            </svg>
          </div>
        )}
      </div>
    </button>
  );
}

function CrowdBar({
  label,
  pct,
  isUserPick,
  variant,
}: {
  label: string;
  pct: number;
  isUserPick: boolean;
  variant: 'rose' | 'brand' | 'muted';
}) {
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (barRef.current) barRef.current.style.width = `${pct}%`;
    }, 600);
    return () => clearTimeout(timer);
  }, [pct]);

  const bgColor = variant === 'rose' ? 'bg-[#ff1368]' : variant === 'brand' ? 'bg-brand' : 'bg-gray-500';

  return (
    <div className="mb-2.5">
      <div className="flex justify-between text-xs mb-1">
        <span className="font-semibold">
          {label}
          {isUserPick && <span className="text-[#ff1368] text-[10px] font-semibold ml-1">(Your pick)</span>}
        </span>
        <span className="text-gray-500">{pct}%</span>
      </div>
      <div className="h-2 rounded bg-surface-overlay overflow-hidden">
        <div
          ref={barRef}
          className={`h-full rounded ${bgColor} transition-all duration-1000 ease-out`}
          style={{ width: 0 }}
        />
      </div>
    </div>
  );
}

// ─── Main Client Component ───

export function BeatTheCriticsClient({ data }: { data: BeatTheCriticsData }) {
  // Hide site chrome (header/footer) — this is a standalone co-branded experience
  useEffect(() => {
    document.body.classList.add('btc-standalone');
    return () => document.body.classList.remove('btc-standalone');
  }, []);
  const [screen, setScreen] = useState<Screen>('landing');
  const [currentTierIdx, setCurrentTierIdx] = useState(0);
  const [currentCatIdx, setCurrentCatIdx] = useState(0);
  const [picks, setPicks] = useState<Record<string, string>>({}); // categoryTitle → showTitle
  const [pickSlugs, setPickSlugs] = useState<Record<string, string>>({}); // categoryTitle → showSlug

  const currentTier = data.tiers[currentTierIdx];
  const currentCategory = currentTier?.categories[currentCatIdx];
  const totalCategoriesInTier = currentTier?.categories.length ?? 0;

  const allCompletedPicks = Object.entries(picks);

  const handlePick = useCallback((category: string, show: SerializedTonyShow) => {
    setPicks(prev => ({ ...prev, [category]: show.title }));
    setPickSlugs(prev => ({ ...prev, [category]: show.slug }));
  }, []);

  const handleLockIn = useCallback(() => {
    if (!currentCategory || !picks[currentCategory.title]) return;
    setScreen('reveal');
  }, [currentCategory, picks]);

  const handleNextCategory = useCallback(() => {
    if (currentCatIdx < totalCategoriesInTier - 1) {
      setCurrentCatIdx(prev => prev + 1);
      setScreen('picking');
    } else {
      // End of tier
      setScreen('results');
    }
  }, [currentCatIdx, totalCategoriesInTier]);

  const handleNextTier = useCallback(() => {
    if (currentTierIdx < data.tiers.length - 1) {
      setCurrentTierIdx(prev => prev + 1);
      setCurrentCatIdx(0);
      setScreen('picking');
    } else {
      setScreen('results');
    }
  }, [currentTierIdx, data.tiers.length]);

  const goToScreen = useCallback((s: Screen) => {
    setScreen(s);
  }, []);

  // ─── LANDING ───
  if (screen === 'landing') {
    return (
      <div className="min-h-screen bg-surface relative overflow-hidden flex flex-col">
        {/* Ambient gradient */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-0 left-1/4 w-96 h-96 bg-[#ff1368]/[0.06] rounded-full blur-[120px]" />
          <div className="absolute bottom-1/4 right-1/4 w-72 h-72 bg-brand/[0.04] rounded-full blur-[100px]" />
        </div>

        <div className="relative z-10 flex-1 flex flex-col items-center justify-center max-w-[480px] mx-auto px-6 py-12 text-center">
          <div className="animate-fade-up" style={{ animationDelay: '0.2s', animationFillMode: 'both' }}>
            <CoBrand />
          </div>

          <div className="animate-fade-up mt-10" style={{ animationDelay: '0.4s', animationFillMode: 'both' }}>
            <span className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-[#ff1368]/10 border border-[#ff1368]/20 text-[#ff1368] text-[11px] font-semibold tracking-widest uppercase">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
              </svg>
              Tony Awards {data.season.ceremonyYear}
            </span>
          </div>

          <h1 className="animate-fade-up mt-6" style={{ animationDelay: '0.5s', animationFillMode: 'both' }}>
            <span className="block text-[52px] font-black leading-[0.95] tracking-tighter">
              Beat{' '}
              <span className="bg-gradient-to-br from-brand to-[#ff1368] bg-clip-text text-transparent">
                the Critics
              </span>
            </span>
          </h1>

          <p className="animate-fade-up mt-5 text-[17px] leading-relaxed text-gray-400 max-w-[360px]" style={{ animationDelay: '0.7s', animationFillMode: 'both' }}>
            Pick Tony winners. Compete against <strong className="text-gray-200 font-semibold">top critics</strong> and the <strong className="text-gray-200 font-semibold">CriticScore algorithm</strong>. Win <strong className="text-gray-200 font-semibold">free tickets</strong>.
          </p>

          <button
            onClick={() => { setCurrentTierIdx(0); setCurrentCatIdx(0); goToScreen('picking'); }}
            className="animate-fade-up mt-9 inline-flex items-center gap-2.5 px-10 py-4 rounded-[14px] bg-gradient-to-br from-[#ff1368] to-[#d4106a] text-white text-[17px] font-bold shadow-[0_4px_24px_rgba(255,19,104,0.35)] hover:shadow-[0_8px_32px_rgba(255,19,104,0.45)] hover:-translate-y-0.5 active:scale-[0.97] transition-all duration-200"
            style={{ animationDelay: '0.9s', animationFillMode: 'both' }}
          >
            Make Your Picks
            <span className="transition-transform group-hover:translate-x-1">&rarr;</span>
          </button>

          <div className="animate-fade-up mt-12 flex gap-6" style={{ animationDelay: '1.1s', animationFillMode: 'both' }}>
            <div className="text-center">
              <div className="text-[22px] font-extrabold text-brand tracking-tight">{(data.stats.reviewsScored / 1000).toFixed(0)}K+</div>
              <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mt-0.5">Reviews Scored</div>
            </div>
            <div className="text-center">
              <div className="text-[22px] font-extrabold text-brand tracking-tight">{data.stats.showsTracked.toLocaleString()}</div>
              <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mt-0.5">Shows Tracked</div>
            </div>
            <div className="text-center">
              <div className="text-[22px] font-extrabold text-brand tracking-tight">{data.stats.criticsTracked}+</div>
              <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mt-0.5">Critics Tracked</div>
            </div>
          </div>

          <div className="animate-fade-up mt-8 flex items-center gap-2.5 px-4 py-2.5 rounded-xl bg-brand/[0.08] border border-brand/15" style={{ animationDelay: '1.3s', animationFillMode: 'both' }}>
            <span className="text-xl">🎫</span>
            <span className="text-[13px] text-gray-400">
              Beat the critics &rarr; enter to win <strong className="text-brand">free TodayTix tickets</strong>
            </span>
          </div>
        </div>
      </div>
    );
  }

  // ─── PICKING ───
  if (screen === 'picking' && currentCategory) {
    const selectedTitle = picks[currentCategory.title];
    const nominees = currentCategory.nominees;

    return (
      <div className="min-h-screen bg-surface flex flex-col">
        {/* Header */}
        <div className="sticky top-0 z-10 px-5 py-4 flex items-center justify-between border-b border-white/5 bg-surface/90 backdrop-blur-xl">
          <button
            onClick={() => currentCatIdx > 0 ? setCurrentCatIdx(prev => prev - 1) : goToScreen('landing')}
            className="text-gray-400 text-sm hover:text-white transition-colors p-2 -m-2"
          >
            &larr; Back
          </button>
          <div className="flex gap-1.5">
            {currentTier.categories.map((_, i) => (
              <div
                key={i}
                className={`h-2 rounded transition-all duration-300 ${
                  i < currentCatIdx ? 'w-2 bg-[#ff1368]'
                  : i === currentCatIdx ? 'w-5 bg-[#ff1368] shadow-[0_0_8px_rgba(255,19,104,0.5)]'
                  : 'w-2 bg-surface-overlay'
                }`}
              />
            ))}
          </div>
          <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
            {currentCatIdx + 1} of {totalCategoriesInTier}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 px-5 py-6 max-w-[480px] mx-auto w-full">
          <div className="inline-flex px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider mb-3 bg-brand/15 text-brand">
            {currentTier.label} &middot; {currentTier.name}
          </div>
          <h2 className="text-[28px] font-extrabold tracking-tight mb-1.5">{currentCategory.title}</h2>
          <p className="text-[13px] text-gray-500 mb-7">Tap your pick. Scores out of 100 via CriticScore.</p>

          <div className="flex flex-col gap-2.5">
            {nominees.map((show) => (
              <NomineeCard
                key={show.slug}
                show={show}
                selected={selectedTitle === show.title}
                onSelect={() => handlePick(currentCategory.title, show)}
              />
            ))}
          </div>

          {nominees.length === 0 && (
            <div className="text-center py-12 text-gray-500">
              <p className="text-lg font-semibold">No nominees yet</p>
              <p className="text-sm mt-2">Nominations will be announced in late April 2026.</p>
            </div>
          )}

          <button
            onClick={handleLockIn}
            disabled={!selectedTitle}
            className={`mt-6 w-full py-4 rounded-[14px] text-base font-bold transition-all duration-200 ${
              selectedTitle
                ? 'bg-gradient-to-br from-[#ff1368] to-[#d4106a] text-white shadow-[0_4px_20px_rgba(255,19,104,0.3)] hover:-translate-y-0.5'
                : 'bg-surface-overlay text-gray-500 cursor-not-allowed'
            }`}
          >
            {selectedTitle ? `Lock In: ${selectedTitle} →` : 'Lock In Pick'}
          </button>

          <p className="text-center mt-3.5 text-xs text-gray-500">
            Not sure? <a href={`/show/${pickSlugs[currentCategory.title] || ''}`} className="text-brand hover:underline">Check the CriticScore on Broadway Scorecard</a>
          </p>
        </div>
      </div>
    );
  }

  // ─── REVEAL ───
  if (screen === 'reveal' && currentCategory) {
    const userPick = picks[currentCategory.title];
    const nominees = currentCategory.nominees;
    const criticScorePick = getCriticScorePick(nominees);
    const criticPicks = getCriticPicks(currentCategory.title, nominees);
    const crowdPcts = getCrowdPercentages(nominees);

    const matchesCriticScore = userPick === criticScorePick;
    const criticMatches = criticPicks.filter(p => p === userPick).length;

    const isLastCategoryInTier = currentCatIdx >= totalCategoriesInTier - 1;
    const hasMoreTiers = currentTierIdx < data.tiers.length - 1;

    return (
      <div className="min-h-screen bg-surface flex flex-col">
        {/* Header */}
        <div className="sticky top-0 z-10 px-5 py-4 flex items-center justify-between border-b border-white/5 bg-surface/90 backdrop-blur-xl">
          <button onClick={() => goToScreen('picking')} className="text-gray-400 text-sm hover:text-white transition-colors p-2 -m-2">
            &larr; Back
          </button>
          <div className="flex gap-1.5">
            {currentTier.categories.map((_, i) => (
              <div
                key={i}
                className={`h-2 rounded transition-all duration-300 ${
                  i <= currentCatIdx ? 'w-2 bg-[#ff1368]' : 'w-2 bg-surface-overlay'
                }`}
              />
            ))}
          </div>
          <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Reveal</div>
        </div>

        {/* Body */}
        <div className="flex-1 px-5 py-6 max-w-[480px] mx-auto w-full">
          <div className="text-center mb-8 animate-fade-up" style={{ animationFillMode: 'both' }}>
            <h2 className="text-2xl font-extrabold">{currentCategory.title}</h2>
            <p className="text-sm text-gray-400 mt-1">Here&apos;s what the experts picked</p>
          </div>

          {/* User's pick */}
          <div className="p-4 rounded-[14px] bg-[#ff1368]/[0.06] border border-[#ff1368]/15 mb-6 animate-fade-up" style={{ animationDelay: '0.15s', animationFillMode: 'both' }}>
            <div className="text-[10px] font-bold uppercase tracking-wider text-[#ff1368] mb-2">Your Pick</div>
            <div className="text-lg font-extrabold">{userPick}</div>
            <div className="text-xs text-gray-400 mt-1">
              {matchesCriticScore && <span className="text-green-500 font-semibold">Matches CriticScore prediction</span>}
              {matchesCriticScore && ' · '}
              You agree with {criticMatches} of {CRITICS.length} critics
            </div>
          </div>

          {/* Critics Panel */}
          <div className="mb-6">
            <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-3">
              Critics Panel
              <span className="text-[10px] font-semibold uppercase tracking-wider">
                Powered by <span className="text-brand">CriticScore</span>
              </span>
              <div className="flex-1 h-px bg-white/5" />
            </div>

            {/* CriticScore */}
            <div className="flex items-center gap-3 p-3 rounded-xl bg-surface-raised mb-2 animate-slide-in" style={{ animationDelay: '0.3s', animationFillMode: 'both' }}>
              <div className="w-9 h-9 rounded-full bg-gradient-to-br from-brand to-[#DAA520] flex items-center justify-center text-[13px] font-bold text-[#1a1a1a] flex-shrink-0">CS</div>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-bold">CriticScore</div>
                <div className="text-[11px] text-gray-500">Broadway Scorecard Algorithm</div>
              </div>
              <div className="text-right max-w-[140px]">
                <div className="text-xs font-semibold truncate">{criticScorePick}</div>
                {userPick === criticScorePick ? (
                  <span className="inline-block mt-0.5 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-green-500/15 text-green-500">Match!</span>
                ) : (
                  <span className="inline-block mt-0.5 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-red-500/10 text-red-500/70">Different</span>
                )}
              </div>
            </div>

            {/* Named critics */}
            {CRITICS.map((critic, i) => (
              <div
                key={critic.name}
                className="flex items-center gap-3 p-3 rounded-xl bg-surface-raised mb-2 animate-slide-in"
                style={{ animationDelay: `${0.4 + i * 0.1}s`, animationFillMode: 'both' }}
              >
                <div className="w-9 h-9 rounded-full bg-surface-overlay flex items-center justify-center text-sm font-bold text-gray-400 flex-shrink-0">
                  {critic.initials}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-bold">{critic.name}</div>
                  <div className="text-[11px] text-gray-500">{critic.outlet}</div>
                </div>
                <div className="text-right max-w-[140px]">
                  <div className="text-xs font-semibold truncate">{criticPicks[i]}</div>
                  {userPick === criticPicks[i] ? (
                    <span className="inline-block mt-0.5 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-green-500/15 text-green-500">Match!</span>
                  ) : (
                    <span className="inline-block mt-0.5 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-red-500/10 text-red-500/70">Different</span>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Crowd */}
          <div className="mb-7 animate-fade-up" style={{ animationDelay: '0.8s', animationFillMode: 'both' }}>
            <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-3">
              What Other Players Picked
              <div className="flex-1 h-px bg-white/5" />
            </div>
            {nominees.map((show, i) => (
              <CrowdBar
                key={show.slug}
                label={show.title}
                pct={crowdPcts[i] ?? 0}
                isUserPick={show.title === userPick}
                variant={show.title === userPick ? 'rose' : i === 0 ? 'brand' : 'muted'}
              />
            ))}
          </div>

          {/* Actions */}
          <div className="flex flex-col gap-2.5 animate-fade-up" style={{ animationDelay: '1s', animationFillMode: 'both' }}>
            {!isLastCategoryInTier ? (
              <button
                onClick={handleNextCategory}
                className="w-full py-4 rounded-[14px] text-base font-bold bg-gradient-to-br from-[#ff1368] to-[#d4106a] text-white shadow-[0_4px_20px_rgba(255,19,104,0.3)] hover:-translate-y-0.5 transition-all"
              >
                Keep Going &rarr;
                <span className="block text-xs font-medium opacity-80 mt-0.5">
                  Next: {currentTier.categories[currentCatIdx + 1]?.title} ({currentCatIdx + 2} of {totalCategoriesInTier})
                </span>
              </button>
            ) : hasMoreTiers ? (
              <button
                onClick={handleNextTier}
                className="w-full py-4 rounded-[14px] text-base font-bold bg-gradient-to-br from-[#ff1368] to-[#d4106a] text-white shadow-[0_4px_20px_rgba(255,19,104,0.3)] hover:-translate-y-0.5 transition-all"
              >
                Continue to {data.tiers[currentTierIdx + 1].name} &rarr;
                <span className="block text-xs font-medium opacity-80 mt-0.5">
                  Bonus picks for bragging rights
                </span>
              </button>
            ) : null}
            <button
              onClick={() => goToScreen('results')}
              className="w-full py-3.5 rounded-[14px] text-sm font-semibold border border-white/10 text-gray-400 hover:border-brand hover:text-brand transition-all"
            >
              Save &amp; Share My Ballot
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── RESULTS ───
  return (
    <div className="min-h-screen bg-surface flex flex-col">
      {/* Header */}
      <div className="sticky top-0 z-10 px-5 py-4 flex items-center justify-between border-b border-white/5 bg-surface/90 backdrop-blur-xl">
        <button onClick={() => goToScreen('reveal')} className="text-gray-400 text-sm hover:text-white transition-colors p-2 -m-2">
          &larr; Back
        </button>
        <div className="text-xs font-bold">Your Ballot</div>
        <div />
      </div>

      <div className="flex-1 px-5 py-8 max-w-[480px] mx-auto w-full flex flex-col items-center">
        {/* Share Card */}
        <div className="w-full max-w-[380px] rounded-[20px] overflow-hidden bg-surface-raised border border-white/10 shadow-[0_20px_60px_rgba(0,0,0,0.5)] animate-fade-up" style={{ animationDelay: '0.2s', animationFillMode: 'both' }}>
          <div className="px-6 pt-6 pb-4 bg-gradient-to-br from-[#ff1368]/10 to-brand/[0.06] border-b border-white/5">
            <CoBrand size="small" />
            <div className="text-[22px] font-black tracking-tight mt-4">My Tony Picks</div>
            <div className="text-[13px] text-gray-400">Beat the Critics &middot; {data.season.ceremonyYear}</div>
          </div>

          <div className="px-6 py-4">
            {allCompletedPicks.map(([category, showTitle]) => (
              <div key={category} className="flex items-center justify-between py-2.5 border-b border-white/5 last:border-b-0">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                  {category.replace('Best ', '').replace('Revival of a ', 'Revival · ')}
                </div>
                <div className="text-[13px] font-bold text-right">{showTitle}</div>
              </div>
            ))}
            {allCompletedPicks.length === 0 && (
              <div className="py-4 text-center text-gray-500 text-sm">No picks made yet</div>
            )}
          </div>

          <div className="px-6 py-4 bg-[#ff1368]/[0.04] border-t border-white/5 text-center">
            <div className="text-sm font-bold text-[#ff1368]">Can you Beat the Critics?</div>
            <div className="text-[11px] text-gray-500 mt-1">todaytix.com/beat-the-critics</div>
          </div>
        </div>

        {/* Email capture */}
        <div className="w-full max-w-[380px] mt-7 p-6 rounded-2xl bg-gradient-to-br from-[#ff1368]/[0.06] to-brand/[0.04] border border-[#ff1368]/10 animate-fade-up" style={{ animationDelay: '0.6s', animationFillMode: 'both' }}>
          <h3 className="text-base font-bold">Get your results on Tony night</h3>
          <p className="text-[13px] text-gray-400 mt-1.5 mb-4">We&apos;ll email you a scorecard showing how you stacked up against the critics.</p>

          <div className="flex gap-2 mb-3">
            <input
              type="email"
              placeholder="you@email.com"
              className="flex-1 px-4 py-3.5 rounded-xl border border-white/10 bg-surface-raised text-white text-sm outline-none focus:border-[#ff1368] transition-colors placeholder:text-gray-500"
            />
            <button className="px-6 py-3.5 rounded-xl bg-[#ff1368] text-white text-sm font-bold hover:bg-[#e6115e] transition-colors whitespace-nowrap">
              Save
            </button>
          </div>

          <label className="flex items-start gap-2.5 text-left cursor-pointer">
            <input type="checkbox" defaultChecked className="mt-0.5 accent-[#ff1368] w-4 h-4" />
            <span className="text-xs text-gray-400 leading-relaxed">
              Enter me in the drawing to win <strong className="text-brand">free TodayTix tickets</strong>
            </span>
          </label>
        </div>

        {/* Share buttons */}
        <div className="flex gap-2.5 mt-5 animate-fade-up" style={{ animationDelay: '0.8s', animationFillMode: 'both' }}>
          {[
            { label: 'Share', icon: <path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8M16 6l-4-4-4 4M12 2v13" /> },
            { label: 'Post', icon: <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" fill="currentColor" stroke="none" /> },
            { label: 'Story', icon: <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="12" cy="12" r="5" /><circle cx="18" cy="6" r="1.5" fill="currentColor" /></> },
          ].map(btn => (
            <button
              key={btn.label}
              className="flex items-center gap-1.5 px-4 py-2.5 rounded-[10px] text-[13px] font-semibold border border-white/10 bg-surface-raised text-white hover:border-brand hover:-translate-y-0.5 transition-all"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                {btn.icon}
              </svg>
              {btn.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
