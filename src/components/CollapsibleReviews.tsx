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
  pullQuote?: string;
}

interface CollapsibleReviewsProps {
  reviews: Review[];
  initialCount?: number;
  renderReview: (review: Review, index: number) => React.ReactNode;
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

export default function CollapsibleReviews({
  reviews,
  initialCount = 5,
  renderReview
}: CollapsibleReviewsProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const shouldCollapse = reviews.length > initialCount;
  const displayedReviews = shouldCollapse && !isExpanded
    ? reviews.slice(0, initialCount)
    : reviews;
  const hiddenCount = reviews.length - initialCount;

  return (
    <div className="space-y-4">
      {displayedReviews.map((review, index) => (
        <div key={index}>
          {renderReview(review, index)}
        </div>
      ))}

      {shouldCollapse && (
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="w-full py-3 px-4 mt-2 flex items-center justify-center gap-2 text-sm font-medium text-brand hover:text-brand-hover bg-surface-overlay/50 hover:bg-surface-overlay rounded-lg transition-all"
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
