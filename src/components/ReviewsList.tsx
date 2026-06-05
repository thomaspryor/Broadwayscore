'use client';

import { useState, useMemo, memo } from 'react';
import Link from 'next/link';
import { getOutletLogoUrlById, getOutletConfigById } from '@/config/outlet-logos';
import { featureFlags } from '@/config/feature-flags';
import { getScoreColorClass } from '@/components/show-cards';
import { getGoldThreshold } from '@/config/score-buckets';

interface Review {
  showId: string;
  outletId: string;
  outlet: string;
  outletSlug?: string;
  criticName?: string;
  criticSlug?: string | null;
  url: string | null;
  publishDate: string;
  tier: 1 | 2 | 3 | 4;
  reviewScore: number;
  designation?: string;
  quote?: string;
  summary?: string;
  pullQuote?: string;
}

interface ReviewsListProps {
  reviews: Review[];
  initialCount?: number;
  category?: string;
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
          onError={() => setImageError(true)}
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

function TopCriticLabel() {
  return (
    <span
      className="hidden md:inline text-[10px] font-semibold uppercase tracking-wide text-blue-400"
      title="Top Critic"
    >
      Top Critic
    </span>
  );
}

// Outlets that pick up tier=1 via the flat-tier opera methodology but are not
// considered tier-1 critics of record by serious opera-goers. We still display
// the review and count it in the composite — we just don't badge it as a Top
// Critic. Maintain in lowercase. Notion 363637c5-416f-8112.
const TOP_CRITIC_BADGE_SUPPRESS: ReadonlySet<string> = new Set([
  'broadwayworld',
]);

function ExternalLinkIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
    </svg>
  );
}

const ReviewCard = memo(function ReviewCard({ review, isLast, category }: { review: Review; isLast: boolean; category?: string }) {
  const goldMin = getGoldThreshold(category);
  let scoreLabel: string;
  if (review.reviewScore >= goldMin) scoreLabel = 'Critical Gold';
  else if (review.reviewScore >= 75) scoreLabel = 'Recommended';
  else if (review.reviewScore >= 65) scoreLabel = 'Worth Seeing';
  else if (review.reviewScore >= 55) scoreLabel = 'Skippable';
  else scoreLabel = 'Critical Miss';

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
        <span style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} className="font-bold text-white text-sm sm:text-base">
          {featureFlags.criticPages && review.outletSlug ? (
            <Link href={`/critics/outlets/${review.outletSlug}`} className="hover:text-brand transition-colors">{review.outlet}</Link>
          ) : review.outlet}
        </span>
        {review.tier === 1 && !TOP_CRITIC_BADGE_SUPPRESS.has((review.outlet || '').toLowerCase()) && <TopCriticLabel />}
        {review.designation === 'Critics_Pick' && <CriticsPickBadge />}
        {review.designation && review.designation !== 'Critics_Pick' && (
          <span className="text-xs text-score-high font-medium whitespace-nowrap hidden sm:inline">
            {review.designation.replace('_', ' ')}
          </span>
        )}
        {formatDate(review.publishDate) && (
          <span className="text-xs text-gray-500 flex-shrink-0">{formatDate(review.publishDate)}</span>
        )}
      </div>

      {/* Quote + Author, indented to align with outlet name */}
      <div className="pl-24 sm:pl-[6.25rem]">
        {review.quote && (
          <p className="text-sm sm:text-base text-gray-300 leading-snug mb-0.5">
            &ldquo;{review.quote}&rdquo;
          </p>
        )}
        {review.summary && !review.quote && (
          <p className="text-sm sm:text-base text-gray-400 leading-snug mb-0.5">
            {review.summary}{/[.!?'""\u2019]$/.test(review.summary.trim()) ? '' : '.'}
          </p>
        )}
        {review.pullQuote && !review.quote && !review.summary && (
          <p className="text-sm sm:text-base text-gray-300 leading-snug mb-0.5">
            &ldquo;{review.pullQuote}{/[.!?''""\u2019]$/.test(review.pullQuote.trim()) ? '' : '.'}&rdquo;
          </p>
        )}

        <div className="flex items-center justify-between text-xs sm:text-sm leading-tight">
          {review.criticName && review.criticName !== 'Unknown' ? (
            <span className="text-sm text-gray-500">By {featureFlags.criticPages && review.criticSlug ? (
              <Link href={`/critics/${review.criticSlug}`} className="hover:text-brand transition-colors">{review.criticName}</Link>
            ) : review.criticName}</span>
          ) : (
            <span className="text-sm text-gray-400">{review.outlet} Staff</span>
          )}
          {review.url && (
            <a
              href={review.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs font-semibold text-brand hover:text-brand-hover transition-colors uppercase tracking-wide"
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

type SortMode = 'score' | 'date';

export default function ReviewsList({ reviews, initialCount = 5, category }: ReviewsListProps) {
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
    return reviews; // already sorted by score from engine
  }, [reviews, sortMode]);

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
        </div>
      )}
      {displayedReviews.map((review) => (
        <ReviewCard
          key={`${review.outletId}-${review.publishDate}`}
          review={review}
          isLast={false}
          category={category}
        />
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
