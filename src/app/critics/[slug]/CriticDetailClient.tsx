'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import type { CriticProfile, ProfileReview } from '@/lib/data-types';
import { getOptimizedImageUrl } from '@/lib/images';
import { getScoreClass, getScoreTextColor, formatDate, ordinalSuffix } from '@/lib/critic-page-utils';

type SortMode = 'recent' | 'highest' | 'lowest';

function ReviewCard({ review }: { review: ProfileReview }) {
  return (
    <article className="card p-4 flex items-center gap-4">
      {/* Thumbnail */}
      <Link href={`/show/${review.showSlug}`} className="w-14 h-14 rounded-lg overflow-hidden bg-surface-overlay flex-shrink-0">
        {review.showThumbnail ? (
          <img
            src={getOptimizedImageUrl(review.showThumbnail, 'thumbnail')}
            alt={review.showTitle}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span className="text-xl">🎭</span>
          </div>
        )}
      </Link>

      {/* Info */}
      <div className="flex-1 min-w-0">
        {review.url ? (
          <a href={review.url} target="_blank" rel="noopener noreferrer" className="font-bold text-white hover:text-brand transition-colors truncate block">
            {review.showTitle}
            <svg className="inline-block w-3 h-3 ml-1 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
        ) : (
          <Link href={`/show/${review.showSlug}`} className="font-bold text-white hover:text-brand transition-colors truncate block">
            {review.showTitle}
          </Link>
        )}
        <p className="text-gray-400 text-sm truncate">
          {review.outletSlug ? (
            <Link href={`/critics/outlets/${review.outletSlug}`} className="hover:text-brand transition-colors">{review.outlet}</Link>
          ) : review.outlet}
          {review.parsedDate ? ` · ${formatDate(review.parsedDate)}` : ''}
        </p>
      </div>

      {/* Score */}
      <div className={`w-10 h-10 text-sm rounded-lg ${getScoreClass(review.reviewScore)} flex items-center justify-center font-bold flex-shrink-0`}>
        {Math.round(review.reviewScore)}
      </div>
    </article>
  );
}

const INITIAL_REVIEWS = 100;

export default function CriticDetailClient({ critic }: { critic: CriticProfile }) {
  const [sortMode, setSortMode] = useState<SortMode>('recent');
  const [showCount, setShowCount] = useState(INITIAL_REVIEWS);

  const sortedReviews = useMemo(() => {
    const sorted = [...critic.reviews];
    if (sortMode === 'recent') {
      sorted.sort((a, b) => (b.parsedDate || 0) - (a.parsedDate || 0));
    } else if (sortMode === 'highest') {
      sorted.sort((a, b) => b.reviewScore - a.reviewScore);
    } else {
      sorted.sort((a, b) => a.reviewScore - b.reviewScore);
    }
    return sorted;
  }, [critic.reviews, sortMode]);

  const visibleReviews = sortedReviews.slice(0, showCount);
  const remaining = sortedReviews.length - showCount;

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="text-sm text-gray-500 mb-6">
        <ol className="flex items-center gap-1.5 flex-wrap">
          <li><Link href="/" className="hover:text-brand transition-colors">Home</Link></li>
          <li className="before:content-['/'] before:mx-1.5"><Link href="/critics" className="hover:text-brand transition-colors">Critics</Link></li>
          <li className="before:content-['/'] before:mx-1.5 text-gray-300 truncate" aria-current="page">{critic.name}</li>
        </ol>
      </nav>

      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-12 h-12 rounded-full bg-surface-overlay flex items-center justify-center flex-shrink-0">
            <span className="text-white font-bold text-lg">
              {critic.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
            </span>
          </div>
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-white">{critic.name}</h1>
            <div className="flex items-center gap-2 text-sm text-gray-400">
              {critic.outlets[0] && (
                <Link href={`/critics/outlets/${critic.reviews.find(r => r.outlet === critic.outlets[0])?.outletSlug || ''}`} className="hover:text-brand transition-colors">
                  {critic.primaryOutlet}
                </Link>
              )}
              {critic.isFreelancer && (
                <span className="text-xs font-medium px-1.5 py-0.5 rounded border bg-purple-500/20 text-purple-400 border-purple-500/30">
                  Freelancer
                </span>
              )}
            </div>
          </div>
        </div>

        {/* All outlets if multi */}
        {critic.outlets.length > 1 && (
          <p className="text-gray-500 text-sm mb-4">
            Also writes for: {critic.outlets.filter(o => o !== critic.primaryOutlet).map((o, i, arr) => {
              const outletReview = critic.reviews.find(r => r.outlet === o);
              const slug = outletReview?.outletSlug || '';
              return (
                <span key={o}>
                  {slug ? <Link href={`/critics/outlets/${slug}`} className="hover:text-brand transition-colors">{o}</Link> : o}
                  {i < arr.length - 1 ? ', ' : ''}
                </span>
              );
            })}
          </p>
        )}

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <div className="card p-4 text-center">
            <p className="text-gray-500 text-xs uppercase tracking-wider mb-2">Reviews</p>
            <p className="text-2xl font-bold text-white">{critic.reviewCount}</p>
          </div>
          <div className="card p-4 text-center">
            <p className="text-gray-500 text-xs uppercase tracking-wider mb-2">Average</p>
            <p className="text-2xl font-bold" style={{ color: getScoreTextColor(critic.avgScore) }}>
              {Math.round(critic.avgScore)}
            </p>
          </div>
          <div className="card p-4 text-center">
            <p className="text-gray-500 text-xs uppercase tracking-wider mb-2">Highest</p>
            <p className="text-2xl font-bold text-white">{critic.highScore}</p>
          </div>
          <div className="card p-4 text-center">
            <p className="text-gray-500 text-xs uppercase tracking-wider mb-2">Lowest</p>
            <p className="text-2xl font-bold text-white">{critic.lowScore}</p>
          </div>
        </div>

        {/* Ranks */}
        <div className="flex flex-wrap gap-3 text-sm text-gray-400">
          <span>{ordinalSuffix(critic.volumeRank)} most prolific critic</span>
          <span className="text-gray-600">·</span>
          <span>{ordinalSuffix(critic.generosityRank)} most generous scorer</span>
        </div>
      </div>

      {/* Sort Controls */}
      <div className="flex items-center gap-0.5 sm:gap-2 flex-wrap mb-4" role="group" aria-label="Sort reviews">
        <span className="text-[11px] font-medium uppercase tracking-wider text-gray-400 mr-1">SORT:</span>
        {(['recent', 'highest', 'lowest'] as SortMode[]).map(mode => (
          <button
            key={mode}
            onClick={() => { setSortMode(mode); setShowCount(INITIAL_REVIEWS); }}
            className={`px-2 py-1 text-[11px] font-medium uppercase tracking-wider rounded transition-colors ${
              sortMode === mode
                ? 'text-brand bg-brand/10 sm:bg-transparent'
                : 'text-gray-300 hover:text-white'
            }`}
          >
            {mode === 'recent' ? 'RECENT' : mode === 'highest' ? 'HIGHEST' : 'LOWEST'}
          </button>
        ))}
      </div>

      {/* Review List */}
      <div className="space-y-2">
        {visibleReviews.length > 0 ? (
          visibleReviews.map((review) => (
            <ReviewCard key={`${review.showSlug}-${review.outletId}-${review.url}`} review={review} />
          ))
        ) : (
          <div className="card p-8 text-center">
            <p className="text-gray-400">No reviews found for this critic.</p>
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
