'use client';

import { useState, useMemo, memo, Fragment, useEffect, useId, useLayoutEffect, useRef } from 'react';
import Link from 'next/link';
import { getOutletLogoUrlById, getOutletConfigById } from '@/config/outlet-logos';
import { featureFlags } from '@/config/feature-flags';
import { getScoreColorClass } from '@/components/show-cards';
import { getGoldThreshold } from '@/config/score-buckets';
import { getReviewKey } from '../../scripts/lib/review-list-key';
import { catchEarlyImgError } from '@/lib/img-early-error';
import { isLondonMarket } from '@/lib/market-utils';
import { TIER_DISPLAY, TIER_LIST, tierBarsLit, tierPercent, type OutletTier } from '@/config/tier-display';
import { nestQuotes } from '@/lib/nest-quotes';

interface Review {
  showId: string;
  outletId: string;
  outlet: string;
  outletSlug?: string;
  criticName?: string;
  criticSlug?: string | null;
  url: string | null;
  publishDate: string;
  tier: OutletTier;
  // Set by the show page when the critic is on TOP_CRITICS, which promotes
  // them to Tier 1 weight wherever they write (BRO-4881 tier chip copy).
  isTopCritic?: boolean;
  reviewScore: number;
  designation?: string;
  quote?: string;
  summary?: string;
  pullQuote?: string;
  // Set when this review belongs to a returning production's declared
  // priorRuns window — e.g. "2022 Gielgud run" — so a since-departed cast
  // member's quote reads in context instead of as current casting (BRO-1397).
  priorRunLabel?: string | null;
  // National tours: the city the tour was playing when this review ran
  // (stopForReview, by publish date). Enables the "By City" sort (BRO-4601).
  stopLabel?: string | null;
}

interface ReviewsListProps {
  reviews: Review[];
  initialCount?: number;
  category?: string;
  // Opera shows weight every outlet equally (engine.ts flattens tiers), so a
  // T1 chip on every row would say nothing. The show page passes false there.
  showTiers?: boolean;
}

function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}

function ChevronUpIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
    </svg>
  );
}

// Use UTC-based formatting to avoid timezone-related display issues
function formatDate(dateStr: string | null | undefined): string {
  // Return empty string for null/undefined/empty dates
  if (!dateStr) {
    return '';
  }

  // Strip ordinal suffixes (1st, 2nd, 3rd, 4th, etc.) that break Date parsing
  const cleanedDateStr = dateStr.replace(/(\d+)(st|nd|rd|th)/gi, '$1');
  const date = new Date(cleanedDateStr);

  // Check for invalid date or Unix epoch (which indicates missing date)
  if (isNaN(date.getTime()) || date.getFullYear() < 1990) {
    return ''; // Hide date instead of showing garbage
  }

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}


function OutletLogo({ outlet, outletId }: { outlet: string; outletId?: string }) {
  const [imageError, setImageError] = useState(false);

  // Resolve by canonical outletId first (covers every registry outlet with a
  // domain), then fall back to the legacy name-keyed map.
  const logoUrl = getOutletLogoUrlById(outletId, outlet);
  const config = getOutletConfigById(outletId, outlet);

  if (logoUrl && !imageError) {
    return (
      <div className="w-8 h-8 rounded-full bg-white flex items-center justify-center flex-shrink-0 overflow-hidden">
        <img
          src={logoUrl}
          alt={`${outlet} logo`}
          className="w-6 h-6 object-contain"
          ref={catchEarlyImgError(() => setImageError(true))} onError={() => setImageError(true)}
        />
      </div>
    );
  }

  // Fallback to colored circle with abbreviation
  if (config) {
    const abbrev = config.abbrev || outlet.charAt(0).toUpperCase();
    const bgColor = config.color || '#374151';
    const textSize = abbrev.length > 2 ? 'text-[9px]' : abbrev.length > 1 ? 'text-[10px]' : 'text-sm';

    return (
      <div
        className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0"
        style={{ backgroundColor: bgColor }}
      >
        <span className={`text-white font-bold ${textSize} leading-none`}>{abbrev}</span>
      </div>
    );
  }

  // Ultimate fallback - first letter
  const firstLetter = outlet.charAt(0).toUpperCase();
  return (
    <div className="w-8 h-8 rounded-full bg-surface-overlay flex items-center justify-center flex-shrink-0 border border-white/10">
      <span className="text-gray-300 font-bold text-sm leading-none">{firstLetter}</span>
    </div>
  );
}

function CriticsPickBadge() {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-500/20 text-amber-400 text-xs font-bold" title="Critics' Pick designation">
      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
      </svg>
      <span>Critics Pick</span>
    </span>
  );
}

// Subtle T1-T4 chip after the outlet name; hover, focus or tap opens a
// popover saying what the tier means and how much the review counts
// (BRO-4881). Replaced the blue "Top Critic" text, which said the same
// thing as T1 and was hidden on mobile.
// Check the cleaned text: nestQuotes may strip the trailing mark that would
// otherwise have counted as end punctuation.
function withEndPunctuation(text: string): string {
  return /[.!?'"’”]$/.test(text) ? text : `${text}.`;
}

// useLayoutEffect warns during the server render of this client component.
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

// Shared by the review-row chip and the key's sample chips so they stay identical.
const TIER_CHIP_BOX = 'inline-flex items-center gap-[3px] h-[18px] px-[5px] rounded border text-[10px] font-semibold leading-none tabular-nums tracking-[0.02em]';

// Four ascending bars, lit one per step of weight (T1 all four, T4 one), so the
// chip shows how much a review counts and not only which tier it is (BRO-4905).
function TierBars({ tier, className = '' }: { tier: OutletTier; className?: string }) {
  return (
    <span className={`inline-flex items-end gap-[1.5px] h-[9px] ${className}`} aria-hidden="true" data-testid="tier-bars">
      {[3, 5, 7, 9].map((h, i) => (
        <span key={h} className={`w-[2px] rounded-[1px] ${i < tierBarsLit(tier) ? 'bg-current' : 'bg-white/[0.14]'}`} style={{ height: h }} />
      ))}
    </span>
  );
}

function TierChip({ tier, isTopCritic, criticName, london }: { tier: OutletTier; isTopCritic?: boolean; criticName?: string; london: boolean }) {
  const [open, setOpen] = useState(false);
  const [shift, setShift] = useState(0);
  const [above, setAbove] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const popRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  // Hover or keyboard focus already opened the popover, so the click (or
  // Enter) that usually follows should keep it open rather than toggle it shut.
  const openedPassively = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>();
  const openPassively = () => {
    clearTimeout(closeTimer.current);
    if (!open) openedPassively.current = true;
    setOpen(true);
  };
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  const popId = useId();
  const info = TIER_DISPLAY[tier];
  const promoted = tier === 1 && isTopCritic;
  const title = promoted ? 'Top critic' : info.title;
  const detail = promoted
    ? `${criticName || 'This critic'} is one of a small group of critics whose reviews count in full wherever they are published.`
    : (london ? info.examplesLondon : info.examplesNyc);

  // Keep the popover inside the viewport: shift it left when the chip sits
  // near the right edge on phones, and open it upward when the chip is too
  // close to the bottom (scrolling to reveal it would close it).
  useIsoLayoutEffect(() => {
    if (!open || !popRef.current || !wrapRef.current) return;
    const rect = popRef.current.getBoundingClientRect();
    const maxRight = document.documentElement.clientWidth - 16;
    const left = rect.left - shift;
    const overRight = left + rect.width - maxRight;
    setShift(overRight > 0 ? -overRight : 0);
    const chip = wrapRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - chip.bottom;
    setAbove(spaceBelow < rect.height + 8 && chip.top > spaceBelow);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e.type === 'pointerdown' && wrapRef.current?.contains(e.target as Node)) return;
      // Tabbing to the popover link can scroll it into view; keep it open.
      if (e.type === 'scroll' && wrapRef.current?.querySelector(':focus-visible')) return;
      // Escape from the popover link would otherwise drop focus to <body>.
      if (e.type === 'keydown' && wrapRef.current?.contains(document.activeElement)) btnRef.current?.focus();
      setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    window.addEventListener('scroll', close, { passive: true });
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
      window.removeEventListener('scroll', close);
    };
  }, [open]);

  return (
    <span
      ref={wrapRef}
      className="relative flex-shrink-0 inline-flex"
      onPointerEnter={(e) => { if (e.pointerType === 'mouse') openPassively(); }}
      onPointerLeave={(e) => {
        // Short grace period so a slightly diagonal path to the link still lands.
        if (e.pointerType === 'mouse') closeTimer.current = setTimeout(() => setOpen(false), 150);
      }}
      onBlur={(e) => { if (!wrapRef.current?.contains(e.relatedTarget as Node)) setOpen(false); }}
    >
      <button
        ref={btnRef}
        type="button"
        className={`tier-chip relative ${TIER_CHIP_BOX} cursor-help transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
          open
            ? 'text-white border-brand/60 bg-brand/[0.08]'
            : `${tier === 1 ? 'text-gray-300' : 'text-gray-400'} border-white/[0.12] hover:text-white hover:border-brand/60 hover:bg-brand/[0.08]`
        }`}
        aria-label={`Tier ${tier}: ${title}. ${info.relative}`}
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        onClick={() => {
          if (open && openedPassively.current) { openedPassively.current = false; return; }
          openedPassively.current = false;
          setOpen(o => !o);
        }}
        onFocus={(e) => { if (e.currentTarget.matches(':focus-visible')) openPassively(); }}
        data-testid="tier-chip"
      >
        T{tier}
        {/* Below 360px the bars cost the outlet name its last letters; the key still shows them. */}
        <TierBars tier={tier} className="max-[359px]:hidden" />
      </button>
      {open && (
        // The outer span's padding bridges the gap to the chip, so the mouse
        // never leaves the hover area on its way to the link.
        <span
          ref={popRef}
          id={popId}
          className={`absolute ${above ? 'bottom-full pb-2' : 'top-full pt-2'} -left-3 z-30 w-72 max-w-[calc(100vw-32px)]`}
          style={{ transform: shift ? `translateX(${shift}px)` : undefined }}
        >
        <span className="relative grid gap-2.5 p-3.5 pb-3 rounded-xl bg-surface-elevated border border-white/10 shadow-[0_16px_40px_-8px_rgba(0,0,0,0.7),0_2px_6px_rgba(0,0,0,0.4)] text-left whitespace-normal font-normal motion-safe:animate-fade-in">
          <span
            aria-hidden="true"
            className={`absolute ${above ? '-bottom-[6px] border-r border-b' : '-top-[6px] border-l border-t'} w-2.5 h-2.5 rotate-45 bg-surface-elevated border-white/10`}
            style={{ left: `${12 + 4 - shift}px` }}
          />
          <span className="flex items-baseline gap-2">
            <span className="text-[11px] font-semibold tracking-[0.04em] text-brand">TIER {tier}</span>
            <span className="text-sm font-bold text-white">{title}</span>
          </span>
          <span className="grid grid-cols-[1fr_auto] items-center gap-2">
            <span className="h-1.5 rounded-full bg-white/[0.08] overflow-hidden">
              <span className="block h-full rounded-full bg-brand" style={{ width: `${info.weight * 100}%` }} />
            </span>
            <span className="text-xs font-semibold text-white tabular-nums">{info.weight.toFixed(2)}×</span>
          </span>
          <span className="text-[13px] leading-snug text-gray-400">
            <span className="font-semibold text-gray-300">{info.relative}</span> {detail}
          </span>
          <Link href="/methodology#critic-score" className="text-xs font-semibold text-brand hover:underline">
            How we weight critics →
          </Link>
        </span>
        </span>
      )}
    </span>
  );
}

function ExternalLinkIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
    </svg>
  );
}

const ReviewCard = memo(function ReviewCard({ review, isLast, category, hideStop, showTiers = true }: { review: Review; isLast: boolean; category?: string; hideStop?: boolean; showTiers?: boolean }) {
  const goldMin = getGoldThreshold(category);
  let scoreLabel: string;
  if (review.reviewScore >= goldMin) scoreLabel = 'Critical Gold';
  else if (review.reviewScore >= 75) scoreLabel = 'Recommended';
  else if (review.reviewScore >= 65) scoreLabel = 'Worth Seeing';
  else if (review.reviewScore >= 55) scoreLabel = 'Mixed';
  else scoreLabel = 'Critical Miss';

  // Phones show the date in the byline instead of the header row, which
  // otherwise squeezes the outlet name to a letter or two next to the tier
  // chip and Critics Pick pill (BRO-4881).
  const dateLabel = formatDate(review.publishDate);
  const mobileDate = dateLabel ? <span className="sm:hidden block text-xs text-gray-500 mt-0.5">{dateLabel}</span> : null;

  return (
    <article className={`${isLast ? '' : 'border-b border-white/5 pb-2'} group`} data-testid="review-card" aria-label={`Review from ${review.outlet}`}>
      {/* CRITICAL: Outlet name vertical centering with score badge and logo.
         Broken 15+ times. Root cause: <a> tags (from Next.js Link) render as
         display:block in flex and ALWAYS stretch to cross-axis height (44px),
         ignoring align-items:center and align-self:center. Only <span> elements
         correctly center. The outlet name MUST be a <span> as the flex child,
         with the <Link> nested inside it (not the other way around).
         Verified via Playwright: <span> = height:20, top:12 (centered in 44px).
         DO NOT put flex/overflow styles on a <Link>/<a> — it will stretch. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '3px' }}>
        <div
          className={`flex-shrink-0 w-11 h-11 sm:w-12 sm:h-12 rounded-lg flex items-center justify-center text-base sm:text-lg font-bold ${getScoreColorClass(review.reviewScore)}`}
          role="meter"
          aria-valuenow={review.reviewScore}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Score: ${review.reviewScore} - ${scoreLabel}`}
        >
          <span aria-hidden="true">{review.reviewScore}</span>
        </div>
        <OutletLogo outlet={review.outlet} outletId={review.outletId} />
        {/* Name + tier chip share the flex-1 slot so the chip hugs the name.
            The wrapper is a <span> (see the comment above); the name span
            keeps the ellipsis, and the chip never truncates. */}
        <span style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} className="font-bold text-white text-sm sm:text-base">
            {featureFlags.criticPages && review.outletSlug ? (
              <Link href={`/critics/outlets/${review.outletSlug}`} className="hover:text-brand transition-colors">{review.outlet}</Link>
            ) : review.outlet}
          </span>
          {showTiers && review.tier && (
            <TierChip tier={review.tier} isTopCritic={review.isTopCritic} criticName={review.criticName} london={isLondonMarket(category)} />
          )}
        </span>
        {review.designation === 'Critics_Pick' && <CriticsPickBadge />}
        {review.designation && review.designation !== 'Critics_Pick' && (
          <span className="text-xs text-score-high font-medium whitespace-nowrap hidden sm:inline">
            {review.designation.replace('_', ' ')}
          </span>
        )}
        {formatDate(review.publishDate) && (
          <span className="hidden sm:inline text-xs text-gray-500 flex-shrink-0">{formatDate(review.publishDate)}</span>
        )}
      </div>

      {/* Quote + Author, indented to align with outlet name */}
      <div className="pl-24 sm:pl-[6.25rem]">
        {review.priorRunLabel && (
          <span
            className="inline-block mb-1 px-2 py-0.5 rounded-pill bg-surface-overlay text-[10px] font-bold uppercase tracking-[0.08em] text-gray-400"
            title="This review is from an earlier run of this production"
          >
            {review.priorRunLabel}
          </span>
        )}
        {review.stopLabel && !hideStop && (
          <span
            className="inline-block mb-1 px-2 py-0.5 rounded-pill bg-surface-overlay text-[10px] font-bold uppercase tracking-[0.08em] text-gray-400"
            title={`Reviewed during the tour's stop in ${review.stopLabel}`}
          >
            {review.stopLabel}
          </span>
        )}
        {review.quote && (
          <p className="text-sm sm:text-base text-gray-300 leading-snug mb-0.5">
            &ldquo;{nestQuotes(review.quote)}&rdquo;
          </p>
        )}
        {review.summary && !review.quote && (
          <p className="text-sm sm:text-base text-gray-400 leading-snug mb-0.5">
            {review.summary}{/[.!?'""\u2019]$/.test(review.summary.trim()) ? '' : '.'}
          </p>
        )}
        {review.pullQuote && !review.quote && !review.summary && (
          <p className="text-sm sm:text-base text-gray-300 leading-snug mb-0.5">
            &ldquo;{withEndPunctuation(nestQuotes(review.pullQuote))}&rdquo;
          </p>
        )}

        <div className="flex items-center justify-between gap-3 text-xs sm:text-sm leading-tight">
          {review.criticName && review.criticName !== 'Unknown' ? (
            <span className="text-sm text-gray-500">By {featureFlags.criticPages && review.criticSlug ? (
              <Link href={`/critics/${review.criticSlug}`} className="hover:text-brand transition-colors">{review.criticName}</Link>
            ) : review.criticName}{mobileDate}</span>
          ) : (
            <span className="text-sm text-gray-400">{review.outlet} Staff{mobileDate}</span>
          )}
          {review.url && (
            <a
              href={review.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex flex-shrink-0 whitespace-nowrap items-center gap-1 text-xs font-semibold text-brand hover:text-brand-hover transition-colors uppercase tracking-wide"
              aria-label={`Read full review from ${review.outlet}${review.criticName && review.criticName !== 'Unknown' ? ` by ${review.criticName}` : ''} (opens in new tab)`}
            >
              Full Review
              <ExternalLinkIcon className="w-3 h-3" />
            </a>
          )}
        </div>
      </div>
    </article>
  );
});

type SortMode = 'score' | 'date' | 'city';

export default function ReviewsList({ reviews, initialCount = 5, category, showTiers = true }: ReviewsListProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>('score');

  const sortedReviews = useMemo(() => {
    if (sortMode === 'date') {
      return [...reviews].sort((a, b) => {
        const da = a.publishDate ? new Date(a.publishDate).getTime() : 0;
        const db = b.publishDate ? new Date(b.publishDate).getTime() : 0;
        return db - da;
      });
    }
    if (sortMode === 'city') {
      // Most recent city first; reviews within a city keep score order.
      const latest = new Map<string, string>();
      for (const r of reviews) {
        const k = r.stopLabel || '';
        if ((r.publishDate || '') > (latest.get(k) || '')) latest.set(k, r.publishDate || '');
      }
      return [...reviews].sort((a, b) => (latest.get(b.stopLabel || '') || '').localeCompare(latest.get(a.stopLabel || '') || ''));
    }
    return reviews; // already sorted by score from engine
  }, [reviews, sortMode]);
  const hasStops = reviews.some(r => r.stopLabel);
  // Same rule as the per-row chips: no tiered review, no key.
  const hasTierChips = showTiers && reviews.some(r => r.tier);

  const shouldCollapse = sortedReviews.length > initialCount;
  const displayedReviews = shouldCollapse && !isExpanded
    ? sortedReviews.slice(0, initialCount)
    : sortedReviews;
  const hiddenCount = sortedReviews.length - initialCount;

  return (
    <div className="space-y-2" role="feed" aria-label="Critic reviews" data-testid="reviews-list">
      {reviews.length > 3 && (
        <div className="flex items-center gap-3 text-xs text-gray-500 mb-1">
          <span>Sort:</span>
          <button
            onClick={() => setSortMode('score')}
            className={`font-medium transition-colors ${sortMode === 'score' ? 'text-white' : 'text-gray-500 hover:text-gray-300'}`}
          >
            By Score
          </button>
          <button
            onClick={() => setSortMode('date')}
            className={`font-medium transition-colors ${sortMode === 'date' ? 'text-white' : 'text-gray-500 hover:text-gray-300'}`}
          >
            By Date
          </button>
          {hasStops && (
            <button
              onClick={() => setSortMode('city')}
              className={`font-medium transition-colors ${sortMode === 'city' ? 'text-white' : 'text-gray-500 hover:text-gray-300'}`}
            >
              By City
            </button>
          )}
        </div>
      )}
      {hasTierChips && (
        // The one tier key: the whole scale at once, so the bars are learned
        // from one line, and its label links to the methodology (BRO-4905).
        <div className="flex items-start gap-3 text-[11px] text-gray-500 mb-1" data-testid="tier-scale">
          <Link href="/methodology#critic-score" className="leading-[18px] whitespace-nowrap hover:text-brand transition-colors" aria-label="Weighted by outlet tier. How we weight critics">
            <span className="hidden sm:inline">Weighted by outlet tier · </span>Counts
          </Link>
          <ul className="flex flex-wrap items-center gap-x-3 gap-y-1.5" aria-label="How much each tier counts">
            {TIER_LIST.map(t => (
              <li key={t} className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className={`${TIER_CHIP_BOX} border-white/[0.12] ${t === 1 ? 'text-gray-300' : 'text-gray-400'}`}>
                  T{t}<TierBars tier={t} />
                </span>
                <span className="tabular-nums text-gray-400"><span className="sr-only">Tier {t}: </span>{tierPercent(t)}%</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {displayedReviews.map((review, i) => (
        <Fragment key={getReviewKey(review)}>
          {sortMode === 'city' && review.stopLabel !== displayedReviews[i - 1]?.stopLabel && (
            <h3 className={`text-[11px] font-bold uppercase tracking-[0.12em] text-gray-400 ${i > 0 ? 'pt-3' : ''}`}>
              {review.stopLabel || 'Other'}
            </h3>
          )}
          <ReviewCard
            review={review}
            isLast={false}
            category={category}
            hideStop={sortMode === 'city'}
            showTiers={showTiers}
          />
        </Fragment>
      ))}

      {shouldCollapse && (
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="w-full py-3 px-4 mt-2 flex items-center justify-center gap-2 text-sm font-medium text-brand hover:text-brand-hover bg-surface-overlay/50 hover:bg-surface-overlay rounded-lg transition-all border border-white/5 hover:border-white/10"
          aria-expanded={isExpanded}
          aria-controls="reviews-list"
        >
          {isExpanded ? (
            <>
              Show less
              <ChevronUpIcon className="w-4 h-4" />
            </>
          ) : (
            <>
              Show {hiddenCount} more {hiddenCount === 1 ? 'review' : 'reviews'}
              <ChevronDownIcon className="w-4 h-4" />
            </>
          )}
        </button>
      )}
    </div>
  );
}
