'use client';

import { useState, memo } from 'react';
import { getOutletLogoUrl, getOutletConfig } from '@/config/outlet-logos';

interface Review {
  showId: string;
  outletId: string;
  outlet: string;
  criticName?: string;
  url: string;
  publishDate: string;
  tier: 1 | 2 | 3;
  reviewScore: number;
  designation?: string;
  quote?: string;
  summary?: string;
  pullQuote?: string;
}

interface ReviewsListProps {
  reviews: Review[];
  initialCount?: number;
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

function getScoreClasses(score: number): string {
  if (score >= 85) return 'score-must-see';
  if (score >= 75) return 'score-great';
  if (score >= 65) return 'score-good';
  if (score >= 55) return 'score-tepid';
  return 'score-skip';
}

function OutletLogo({ outlet }: { outlet: string }) {
  const [imageError, setImageError] = useState(false);

  const logoUrl = getOutletLogoUrl(outlet);
  const config = getOutletConfig(outlet);

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

function ExternalLinkIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
    </svg>
  );
}

const ReviewCard = memo(function ReviewCard({ review, isLast }: { review: Review; isLast: boolean }) {
  let scoreLabel: string;
  if (review.reviewScore >= 85) scoreLabel = 'Must-See';
  else if (review.reviewScore >= 75) scoreLabel = 'Recommended';
  else if (review.reviewScore >= 65) scoreLabel = 'Worth Seeing';
  else if (review.reviewScore >= 55) scoreLabel = 'Skippable';
  else scoreLabel = 'Stay Away';

  return (
    <article className={`${isLast ? '' : 'border-b border-white/5 pb-3'} group`} aria-label={`Review from ${review.outlet}`}>
      <div className="flex items-start gap-3">
        {/* Score on LEFT - Metacritic style - smaller on mobile */}
        <div
          className={`flex-shrink-0 w-11 h-11 sm:w-12 sm:h-12 rounded-lg flex items-center justify-center text-base sm:text-lg font-bold ${getScoreClasses(review.reviewScore)}`}
          role="meter"
          aria-valuenow={review.reviewScore}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Score: ${review.reviewScore} - ${scoreLabel}`}
        >
          <span aria-hidden="true">{review.reviewScore}</span>
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1">
          {/* Outlet name + Badge - stacks on mobile */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-0.5 sm:gap-2 mb-1">
            <div className="flex items-center gap-2 sm:gap-2.5 min-w-0">
              <OutletLogo outlet={review.outlet} />
              <span className="font-bold text-white text-sm sm:text-base truncate">{review.outlet}</span>
              {review.designation === 'Critics_Pick' && <CriticsPickBadge />}
              {review.designation && review.designation !== 'Critics_Pick' && (
                <span className="text-xs text-score-high font-medium whitespace-nowrap hidden sm:inline">
                  {review.designation.replace('_', ' ')}
                </span>
              )}
            </div>
            {formatDate(review.publishDate) && (
              <span className="text-xs text-gray-500 flex-shrink-0 pl-10 sm:pl-0">{formatDate(review.publishDate)}</span>
            )}
          </div>

          {/* Quote/Summary - larger text */}
          {review.quote && (
            <p className="text-sm sm:text-base text-gray-300 leading-snug mb-1">
              &ldquo;{review.quote}&rdquo;
            </p>
          )}
          {review.summary && !review.quote && (
            <p className="text-sm sm:text-base text-gray-400 leading-snug mb-1">
              {review.summary}{/[.!?'""\u2019]$/.test(review.summary.trim()) ? '' : '.'}
            </p>
          )}
          {review.pullQuote && !review.quote && !review.summary && (
            <p className="text-sm sm:text-base text-gray-400 leading-snug mb-1">
              {review.pullQuote}{/[.!?'""\u2019]$/.test(review.pullQuote.trim()) ? '' : '.'}
            </p>
          )}

          {/* Author at BOTTOM + Full Review link */}
          <div className="flex items-center justify-between">
            {review.criticName && (
              <span className="text-sm text-gray-500">By {review.criticName}</span>
            )}
            {!review.criticName && <span />}
            <a
              href={review.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs font-semibold text-brand hover:text-brand-hover transition-colors uppercase tracking-wide"
              aria-label={`Read full review from ${review.outlet}${review.criticName ? ` by ${review.criticName}` : ''} (opens in new tab)`}
            >
              Full Review
              <ExternalLinkIcon className="w-3 h-3" />
            </a>
          </div>
        </div>
      </div>
    </article>
  );
});

export default function ReviewsList({ reviews, initialCount = 5 }: ReviewsListProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const shouldCollapse = reviews.length > initialCount;
  const displayedReviews = shouldCollapse && !isExpanded
    ? reviews.slice(0, initialCount)
    : reviews;
  const hiddenCount = reviews.length - initialCount;

  return (
    <div className="space-y-3" role="feed" aria-label="Critic reviews">
      {displayedReviews.map((review) => (
        <ReviewCard
          key={`${review.outletId}-${review.publishDate}`}
          review={review}
          isLast={false}
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
