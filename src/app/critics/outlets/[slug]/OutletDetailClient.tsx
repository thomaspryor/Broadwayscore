'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import type { OutletProfile, ProfileReview } from '@/lib/data-types';
import { getOptimizedImageUrl } from '@/lib/images';

type SortMode = 'recent' | 'highest' | 'lowest';

function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function ordinalSuffix(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function getScoreClass(score: number): string {
  const r = Math.round(score);
  if (r >= 85) return 'score-must-see';
  if (r >= 75) return 'score-great';
  if (r >= 65) return 'score-good';
  if (r >= 55) return 'score-tepid';
  return 'score-skip';
}

function getScoreTextColor(score: number): string {
  const r = Math.round(score);
  if (r >= 85) return '#FFD700';
  if (r >= 75) return '#22c55e';
  if (r >= 65) return '#14b8a6';
  if (r >= 55) return '#f59e0b';
  return '#ef4444';
}

function TierBadge({ tier }: { tier: 1 | 2 | 3 }) {
  const cls = tier === 1
    ? 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'
    : tier === 2
    ? 'bg-blue-500/20 text-blue-400 border-blue-500/30'
    : 'bg-gray-500/20 text-gray-400 border-gray-500/30';
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded border ${cls}`}>
      Tier {tier}
    </span>
  );
}

function formatDate(parsedDate: number | null): string {
  if (!parsedDate) return '';
  return new Date(parsedDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function ReviewCard({ review }: { review: ProfileReview }) {
  return (
    <div className="card p-4 flex items-center gap-4">
      {/* Thumbnail — links to show page */}
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
          {review.criticName && review.criticName !== 'Unknown' ? <><Link href={`/critics/${toSlug(review.criticName)}`} className="hover:text-brand transition-colors">{review.criticName}</Link>{' · '}</> : ''}
          {review.parsedDate ? formatDate(review.parsedDate) : ''}
        </p>
      </div>

      {/* Score */}
      <div className={`w-10 h-10 text-sm rounded-lg ${getScoreClass(review.reviewScore)} flex items-center justify-center font-bold flex-shrink-0`}>
        {Math.round(review.reviewScore)}
      </div>
    </div>
  );
}

const INITIAL_SHOW = 25;

export default function OutletDetailClient({ outlet }: { outlet: OutletProfile }) {
  const [sortMode, setSortMode] = useState<SortMode>('recent');
  const [showCount, setShowCount] = useState(INITIAL_SHOW);

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

  const visibleReviews = sortedReviews.slice(0, showCount);
  const remaining = sortedReviews.length - showCount;

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
      {/* Breadcrumb */}
      <nav className="text-sm text-gray-500 mb-6 flex items-center gap-1.5 flex-wrap">
        <Link href="/" className="hover:text-brand transition-colors">Home</Link>
        <span>/</span>
        <Link href="/critics" className="hover:text-brand transition-colors">Critics</Link>
        <span>/</span>
        <Link href="/critics/outlets" className="hover:text-brand transition-colors">Outlets</Link>
        <span>/</span>
        <span className="text-gray-300 truncate">{outlet.name}</span>
      </nav>

      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-3">
          {outlet.logoDomain ? (
            <img
              src={`https://www.google.com/s2/favicons?domain=${outlet.logoDomain}&sz=64`}
              alt={outlet.name}
              className="w-10 h-10 rounded"
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

        {/* Stats — all 4 boxes consistent */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <div className="card p-4 text-center">
            <p className="text-gray-500 text-xs uppercase tracking-wider mb-2">Reviews</p>
            <p className="text-2xl font-bold text-white">{outlet.reviewCount}</p>
          </div>
          <div className="card p-4 text-center">
            <p className="text-gray-500 text-xs uppercase tracking-wider mb-2">Average</p>
            <p className="text-2xl font-bold" style={{ color: getScoreTextColor(outlet.avgScore) }}>
              {Math.round(outlet.avgScore)}
            </p>
          </div>
          <div className="card p-4 text-center">
            <p className="text-gray-500 text-xs uppercase tracking-wider mb-2">Highest</p>
            <p className="text-2xl font-bold text-white">{outlet.highScore}</p>
          </div>
          <div className="card p-4 text-center">
            <p className="text-gray-500 text-xs uppercase tracking-wider mb-2">Lowest</p>
            <p className="text-2xl font-bold text-white">{outlet.lowScore}</p>
          </div>
        </div>

        {/* Ranks */}
        <div className="flex flex-wrap gap-3 text-sm text-gray-400">
          <span>{ordinalSuffix(outlet.volumeRank)} most prolific outlet</span>
          <span className="text-gray-600">·</span>
          <span>{ordinalSuffix(outlet.generosityRank)} most generous scorer</span>
          <span className="text-gray-600">·</span>
          <span>{outlet.criticCount} different critic{outlet.criticCount !== 1 ? 's' : ''}</span>
        </div>
      </div>

      {/* Sort Controls — plain text, matching homepage */}
      <div className="flex items-center gap-0.5 sm:gap-2 flex-wrap mb-4" role="group" aria-label="Sort reviews">
        <span className="text-[11px] font-medium uppercase tracking-wider text-gray-400 mr-1">SORT:</span>
        {(['recent', 'highest', 'lowest'] as SortMode[]).map(mode => (
          <button
            key={mode}
            onClick={() => { setSortMode(mode); setShowCount(INITIAL_SHOW); }}
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
        {visibleReviews.map((review, i) => (
          <ReviewCard key={`${review.showSlug}-${review.outletId}-${i}`} review={review} />
        ))}
      </div>

      {/* Show More */}
      {remaining > 0 && (
        <button
          onClick={() => setShowCount(prev => prev + 50)}
          className="mt-4 w-full py-3 text-sm text-gray-400 hover:text-white border border-white/10 rounded-lg hover:bg-surface-overlay transition-colors"
        >
          Show {Math.min(remaining, 50)} more review{remaining === 1 ? '' : 's'}
        </button>
      )}
    </div>
  );
}
