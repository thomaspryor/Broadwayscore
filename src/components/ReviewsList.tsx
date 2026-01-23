'use client';

import { useState } from 'react';

interface Review {
  showId: string;
  outletId: string;
  outlet: string;
  criticName?: string;
  url: string;
  publishDate: string;
  tier: 1 | 2 | 3;
  reviewMetaScore: number;
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
function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

function getScoreClasses(score: number): string {
  if (score >= 70) return 'bg-score-high text-white';
  if (score >= 50) return 'bg-score-medium text-gray-900';
  return 'bg-score-low text-white';
}

function OutletLogo({ outlet }: { outlet: string }) {
  const outletLower = outlet.toLowerCase();

  if (outletLower.includes('new york times') || outletLower === 'nyt') {
    return (
      <div className="w-8 h-8 rounded-full bg-white flex items-center justify-center flex-shrink-0">
        <span className="text-black font-serif font-bold text-lg leading-none">T</span>
      </div>
    );
  }

  if (outletLower.includes('vulture')) {
    return (
      <div className="w-8 h-8 rounded-full bg-orange-500 flex items-center justify-center flex-shrink-0">
        <span className="text-white font-bold text-sm leading-none">V</span>
      </div>
    );
  }

  if (outletLower.includes('variety')) {
    return (
      <div className="w-8 h-8 rounded-full bg-red-600 flex items-center justify-center flex-shrink-0">
        <span className="text-white font-bold text-sm leading-none">V</span>
      </div>
    );
  }

  if (outletLower.includes('hollywood reporter')) {
    return (
      <div className="w-8 h-8 rounded-full bg-black flex items-center justify-center flex-shrink-0 border border-white/20">
        <span className="text-white font-bold text-[10px] leading-none">THR</span>
      </div>
    );
  }

  if (outletLower.includes('ny post') || outletLower.includes('new york post')) {
    return (
      <div className="w-8 h-8 rounded-full bg-red-700 flex items-center justify-center flex-shrink-0">
        <span className="text-white font-bold text-[10px] leading-none">POST</span>
      </div>
    );
  }

  if (outletLower.includes('entertainment weekly')) {
    return (
      <div className="w-8 h-8 rounded-full bg-red-500 flex items-center justify-center flex-shrink-0">
        <span className="text-white font-bold text-xs leading-none">EW</span>
      </div>
    );
  }

  if (outletLower.includes('timeout') || outletLower.includes('time out')) {
    return (
      <div className="w-8 h-8 rounded-full bg-red-600 flex items-center justify-center flex-shrink-0">
        <span className="text-white font-bold text-[10px] leading-none">TO</span>
      </div>
    );
  }

  if (outletLower.includes('theatermania')) {
    return (
      <div className="w-8 h-8 rounded-full bg-purple-600 flex items-center justify-center flex-shrink-0">
        <span className="text-white font-bold text-[10px] leading-none">TM</span>
      </div>
    );
  }

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

function ReviewCard({ review, isLast }: { review: Review; isLast: boolean }) {
  const scoreLabel = review.reviewMetaScore >= 70 ? 'Positive' : review.reviewMetaScore >= 50 ? 'Mixed' : 'Negative';

  return (
    <article className={`${isLast ? '' : 'border-b border-white/5 pb-4'} group`} aria-label={`Review from ${review.outlet}`}>
      <div className="flex items-start gap-3">
        {/* Score on LEFT - Metacritic style */}
        <div
          className={`flex-shrink-0 w-12 h-12 rounded-lg flex items-center justify-center text-lg font-bold ${getScoreClasses(review.reviewMetaScore)}`}
          role="meter"
          aria-valuenow={review.reviewMetaScore}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Score: ${review.reviewMetaScore} - ${scoreLabel}`}
        >
          <span aria-hidden="true">{review.reviewMetaScore}</span>
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1">
          {/* Outlet name + Badge + Date row */}
          <div className="flex items-center justify-between gap-2 mb-1 flex-nowrap">
            <div className="flex items-center gap-2 min-w-0">
              <OutletLogo outlet={review.outlet} />
              <span className="font-bold text-white text-base truncate">{review.outlet}</span>
              {review.designation === 'Critics_Pick' && <CriticsPickBadge />}
              {review.designation && review.designation !== 'Critics_Pick' && (
                <span className="text-xs text-score-high font-medium whitespace-nowrap">
                  {review.designation.replace('_', ' ')}
                </span>
              )}
            </div>
            <span className="text-xs text-gray-500 flex-shrink-0 whitespace-nowrap">{formatDate(review.publishDate)}</span>
          </div>

          {/* Quote/Summary */}
          {review.quote && (
            <p className="text-sm text-gray-300 leading-relaxed mb-2">
              &ldquo;{review.quote}&rdquo;
            </p>
          )}
          {review.summary && !review.quote && (
            <p className="text-sm text-gray-400 leading-relaxed mb-2">
              {review.summary}
            </p>
          )}
          {review.pullQuote && !review.quote && !review.summary && (
            <p className="text-sm text-gray-400 leading-relaxed mb-2">
              {review.pullQuote}
            </p>
          )}

          {/* Author at BOTTOM + Full Review link */}
          <div className="flex items-center justify-between mt-2">
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
}

export default function ReviewsList({ reviews, initialCount = 5 }: ReviewsListProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const shouldCollapse = reviews.length > initialCount;
  const displayedReviews = shouldCollapse && !isExpanded
    ? reviews.slice(0, initialCount)
    : reviews;
  const hiddenCount = reviews.length - initialCount;

  return (
    <div className="space-y-4" role="feed" aria-label="Critic reviews">
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
              Show {hiddenCount} more review{hiddenCount > 1 ? 's' : ''}
              <ChevronDownIcon className="w-4 h-4" />
            </>
          )}
        </button>
      )}
    </div>
  );
}
