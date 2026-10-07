'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import type { OutletProfile, ProfileReview } from '@/lib/data-types';
import { getOptimizedImageUrl } from '@/lib/images';
import { getScoreClass, getScoreTextColor, formatDate, ordinalSuffix, TierBadge } from '@/lib/critic-page-utils';
import { ToggleBar, StatGrid } from '@/components/show-cards';
import Breadcrumb from '@/components/Breadcrumb';
import { getReviewKey } from '../../../../../scripts/lib/review-list-key';

type SortMode = 'recent' | 'highest' | 'lowest';

/** Extract opening year from showOpeningDate string (e.g., "2021-12-09" → "2021") */
function getShowYear(review: ProfileReview): string | null {
  if (review.showOpeningDate) {
    const year = review.showOpeningDate.slice(0, 4);
    if (/^\d{4}$/.test(year)) return year;
  }
  return null;
}

function ReviewCard({ review, showYear, loading = 'lazy' }: { review: ProfileReview; showYear?: string | null; loading?: 'eager' | 'lazy' }) {
  return (
    <article className="card p-4 flex gap-4">
      {/* Thumbnail */}
      <Link href={`/show/${review.showSlug}`} className="w-14 h-14 rounded-lg overflow-hidden bg-surface-overlay flex-shrink-0 self-start">
        {review.showThumbnail ? (
          <img
            src={getOptimizedImageUrl(review.showThumbnail, 'thumbnail')}
            alt={review.showTitle}
            className="w-full h-full object-cover"
            width={56}
            height={56}
            loading={loading}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span className="text-xl">🎭</span>
          </div>
        )}
      </Link>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            {review.url ? (
              <a href={review.url} target="_blank" rel="noopener noreferrer" className="font-bold text-white hover:text-brand transition-colors truncate block">
                {review.showTitle}{showYear && <span className="text-gray-500 font-normal text-sm ml-1">({showYear})</span>}
                <svg className="inline-block w-3 h-3 ml-1 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
              </a>
            ) : (
              <Link href={`/show/${review.showSlug}`} className="font-bold text-white hover:text-brand transition-colors truncate block">
                {review.showTitle}{showYear && <span className="text-gray-500 font-normal text-sm ml-1">({showYear})</span>}
              </Link>
            )}
            <p className="text-gray-400 text-sm truncate">
              {review.criticName && review.criticName !== 'Unknown' ? (
                <>
                  {review.criticSlug ? (
                    <Link href={`/critics/${review.criticSlug}`} className="hover:text-brand transition-colors">{review.criticName}</Link>
                  ) : review.criticName}
                  {' · '}
                </>
              ) : ''}
              {review.parsedDate ? formatDate(review.parsedDate) : ''}
            </p>
          </div>

          {/* Score */}
          <div className={`w-10 h-10 text-sm rounded-lg ${getScoreClass(review.reviewScore)} flex items-center justify-center font-bold flex-shrink-0`}>
            {Math.round(review.reviewScore)}
          </div>
        </div>

        {/* Excerpt */}
        {review.quote && (
          <p className="text-gray-500 text-sm mt-2 line-clamp-2 italic leading-relaxed">
            &ldquo;{review.quote}&rdquo;
          </p>
        )}
      </div>
    </article>
  );
}

const INITIAL_REVIEWS = 100;

export default function OutletDetailClient({ outlet }: { outlet: OutletProfile }) {
  const [sortMode, setSortMode] = useState<SortMode>('recent');
  const [showCount, setShowCount] = useState(INITIAL_REVIEWS);

  const sortedReviews = useMemo(() => {
    const sorted = [...outlet.reviews];
    if (sortMode === 'recent') {
      sorted.sort((a, b) => (b.parsedDate || 0) - (a.parsedDate || 0));
    } else if (sortMode === 'highest') {
      sorted.sort((a, b) => b.reviewScore - a.reviewScore);
    } else {
      sorted.sort((a, b) => a.reviewScore - b.reviewScore);
    }
    return sorted;
  }, [outlet.reviews, sortMode]);

  const duplicateTitles = useMemo(() => {
    const titleCounts = new Map<string, number>();
    for (const r of outlet.reviews) {
      titleCounts.set(r.showTitle, (titleCounts.get(r.showTitle) || 0) + 1);
    }
    const dupes = new Set<string>();
    for (const [title, count] of Array.from(titleCounts)) {
      if (count > 1) dupes.add(title);
    }
    return dupes;
  }, [outlet.reviews]);

  const visibleReviews = sortedReviews.slice(0, showCount);
  const remaining = sortedReviews.length - showCount;

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
      {/* Breadcrumb */}
      <Breadcrumb items={[
        { label: 'Home', href: '/' },
        { label: 'Critics', href: '/critics' },
        { label: 'Outlets', href: '/critics/outlets' },
        { label: outlet.name },
      ]} />

      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-3">
          {outlet.logoDomain ? (
            <img
              src={`https://www.google.com/s2/favicons?domain=${outlet.logoDomain}&sz=64`}
              alt=""
              aria-hidden="true"
              className="w-10 h-10 rounded"
              loading="lazy"
            />
          ) : (
            <div
              className="w-10 h-10 rounded flex items-center justify-center text-sm font-bold text-white"
              style={{ backgroundColor: outlet.logoColor || '#6b7280' }}
            >
              {outlet.logoAbbrev || outlet.name.charAt(0)}
            </div>
          )}
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl sm:text-3xl font-bold text-white">{outlet.name}</h1>
              <TierBadge tier={outlet.tier} />
            </div>
          </div>
        </div>

        {/* Stats */}
        <StatGrid className="mb-4" stats={[
          { label: 'Reviews', value: outlet.reviewCount },
          { label: 'Average', value: Math.round(outlet.avgScore), color: getScoreTextColor(outlet.avgScore) },
          { label: 'Highest', value: outlet.highScore },
          { label: 'Lowest', value: outlet.lowScore },
        ]} />

        {/* Ranks */}
        <div className="flex flex-wrap gap-3 text-sm text-gray-400">
          <span>{ordinalSuffix(outlet.volumeRank)} most prolific outlet</span>
          <span className="text-gray-600">·</span>
          <span>{ordinalSuffix(outlet.generosityRank)} most generous scorer</span>
          <span className="text-gray-600">·</span>
          <span>{outlet.criticCount} different critic{outlet.criticCount !== 1 ? 's' : ''}</span>
        </div>
      </div>

      {/* Sort Controls */}
      <ToggleBar
        label="SORT:"
        options={[
          { value: 'recent' as SortMode, label: 'RECENT' },
          { value: 'highest' as SortMode, label: 'HIGHEST' },
          { value: 'lowest' as SortMode, label: 'LOWEST' },
        ]}
        value={sortMode}
        onChange={(mode) => { setSortMode(mode); setShowCount(INITIAL_REVIEWS); }}
        ariaLabel="Sort reviews"
        size="compact"
        className="mb-4"
      />

      {/* Review List */}
      <div className="space-y-2">
        {visibleReviews.length > 0 ? (
          visibleReviews.map((review, index) => (
            <ReviewCard key={`${review.showSlug}-${getReviewKey(review)}`} review={review} showYear={duplicateTitles.has(review.showTitle) ? getShowYear(review) : null} loading={index < 4 ? 'eager' : 'lazy'} />
          ))
        ) : (
          <div className="card p-8 text-center">
            <p className="text-gray-400">No reviews found for this outlet.</p>
          </div>
        )}
      </div>

      {/* Show More */}
      {remaining > 0 && (
        <button
          onClick={() => setShowCount(prev => prev + 100)}
          className="mt-4 w-full py-3 text-sm text-gray-400 hover:text-white border border-white/10 rounded-lg hover:bg-surface-overlay transition-colors"
        >
          Show {Math.min(remaining, 100)} more review{remaining === 1 ? '' : 's'}
        </button>
      )}
    </div>
  );
}
