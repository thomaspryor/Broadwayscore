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
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}

function ChevronUpIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
    </svg>
  );
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function getScoreColor(score: number): string {
  if (score >= 70) return '#10b981';
  if (score >= 50) return '#f59e0b';
  return '#ef4444';
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
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-500/20 text-amber-400 text-xs font-bold">
      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
      </svg>
      Critics Pick
    </span>
  );
}

function ReviewCard({ review, isLast }: { review: Review; isLast: boolean }) {
  return (
    <div className={`${isLast ? '' : 'border-b border-white/5 pb-4'} group`}>
      <div className="flex items-start gap-3">
        <OutletLogo outlet={review.outlet} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div>
              <a
                href={review.url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-white hover:text-brand transition-colors"
              >
                {review.outlet}
              </a>
              {review.criticName && (
                <span className="text-gray-500 text-sm ml-2">by {review.criticName}</span>
              )}
            </div>
            <div className="flex-shrink-0 text-xl font-bold transition-transform group-hover:scale-110" style={{ color: getScoreColor(review.reviewMetaScore) }}>
              {review.reviewMetaScore}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 mt-1">
            <span className="text-xs text-gray-500">{formatDate(review.publishDate)}</span>
            {review.designation === 'Critics_Pick' && <CriticsPickBadge />}
            {review.designation && review.designation !== 'Critics_Pick' && (
              <span className="text-xs text-score-high font-medium">
                {review.designation.replace('_', ' ')}
              </span>
            )}
          </div>
          {review.quote && (
            <blockquote className="mt-2 text-sm text-gray-300 italic border-l-2 border-brand/30 pl-3 group-hover:border-brand/50 transition-colors">
              &ldquo;{review.quote}&rdquo;
            </blockquote>
          )}
          {review.summary && !review.quote && (
            <p className="mt-2 text-sm text-gray-400 border-l-2 border-white/10 pl-3 group-hover:border-white/20 transition-colors">
              {review.summary}
            </p>
          )}
          {review.pullQuote && !review.quote && !review.summary && (
            <p className="mt-2 text-sm text-gray-400 border-l-2 border-white/10 pl-3 group-hover:border-white/20 transition-colors">
              {review.pullQuote}
            </p>
          )}
        </div>
      </div>
    </div>
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
    <div className="space-y-4">
      {displayedReviews.map((review, index) => (
        <ReviewCard
          key={index}
          review={review}
          isLast={index === displayedReviews.length - 1 && !shouldCollapse}
        />
      ))}

      {shouldCollapse && (
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="w-full py-3 px-4 mt-2 flex items-center justify-center gap-2 text-sm font-medium text-brand hover:text-brand-hover bg-surface-overlay/50 hover:bg-surface-overlay rounded-lg transition-all border border-white/5 hover:border-white/10"
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
