'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import type { VideoCreatorProfile, VideoCreatorReview } from '@/lib/data-video-critics';
import { getOptimizedImageUrl } from '@/lib/images';
import { getScoreClass, getScoreTextColor, ordinalSuffix } from '@/lib/critic-page-utils';
import { ToggleBar, StatGrid } from '@/components/show-cards';
import Breadcrumb from '@/components/Breadcrumb';

type SortMode = 'recent' | 'highest' | 'lowest';

function TikTokIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-3 h-3" aria-hidden="true">
      <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-2.88 2.5 2.89 2.89 0 0 1-2.89-2.89 2.89 2.89 0 0 1 2.89-2.89c.28 0 .54.04.79.1v-3.5a6.37 6.37 0 0 0-.79-.05A6.34 6.34 0 0 0 3.15 15a6.34 6.34 0 0 0 6.34 6.34 6.34 6.34 0 0 0 6.34-6.34V8.47a8.35 8.35 0 0 0 4.76 1.49V6.51a4.79 4.79 0 0 1-1-.18z" />
    </svg>
  );
}

function YouTubeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-3 h-3" aria-hidden="true">
      <path d="M23.5 6.19a3 3 0 0 0-2.11-2.12C19.55 3.5 12 3.5 12 3.5s-7.55 0-9.39.57A3 3 0 0 0 .5 6.19 31.16 31.16 0 0 0 0 12a31.16 31.16 0 0 0 .5 5.81 3 3 0 0 0 2.11 2.12c1.84.57 9.39.57 9.39.57s7.55 0 9.39-.57a3 3 0 0 0 2.11-2.12A31.16 31.16 0 0 0 24 12a31.16 31.16 0 0 0-.5-5.81zM9.6 15.6V8.4L15.84 12 9.6 15.6z" />
    </svg>
  );
}

function PlatformPill({ platform }: { platform: string }) {
  if (platform === 'youtube') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-600/20 text-red-400 text-[10px] font-medium border border-red-500/30">
        <YouTubeIcon />
        YouTube
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-white/10 text-gray-300 text-[10px] font-medium border border-white/15">
      <TikTokIcon />
      TikTok
    </span>
  );
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '';
  try {
    const normalized = dateStr.length === 8 && /^\d{8}$/.test(dateStr)
      ? `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`
      : dateStr;
    const d = new Date(normalized + 'T00:00:00');
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return '';
  }
}

function getShowYear(review: VideoCreatorReview): string | null {
  if (review.showOpeningDate) {
    const year = review.showOpeningDate.slice(0, 4);
    if (/^\d{4}$/.test(year)) return year;
  }
  return null;
}

function ReviewCard({ review, showYear, loading = 'lazy' }: { review: VideoCreatorReview; showYear?: string | null; loading?: 'eager' | 'lazy' }) {
  return (
    <article className="card p-4 flex gap-4">
      <Link
        href={`/show/${review.showSlug}`}
        className="w-14 h-14 rounded-lg overflow-hidden bg-surface-overlay flex-shrink-0 self-start"
      >
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

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <Link
              href={`/show/${review.showSlug}`}
              className="font-bold text-white hover:text-brand transition-colors truncate block"
            >
              {review.showTitle}
              {showYear && <span className="text-gray-500 font-normal text-sm ml-1">({showYear})</span>}
            </Link>
            <p className="text-gray-400 text-sm flex items-center flex-wrap gap-x-1.5 gap-y-1">
              {review.publishedAt && <span className="whitespace-nowrap">{formatDate(review.publishedAt)}</span>}
              {review.publishedAt && <span className="text-gray-600">·</span>}
              <a
                href={review.videoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 hover:text-brand transition-colors"
                aria-label={`Watch on ${review.platform === 'youtube' ? 'YouTube' : 'TikTok'}`}
              >
                Watch
                <svg className="w-3 h-3 opacity-60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
                <PlatformPill platform={review.platform} />
              </a>
            </p>
          </div>

          <div className={`w-10 h-10 text-sm rounded-lg ${getScoreClass(review.score)} flex items-center justify-center font-bold flex-shrink-0`}>
            {review.score}
          </div>
        </div>

        {review.keyQuote && (
          <p className="text-gray-500 text-sm mt-2 line-clamp-2 italic leading-relaxed">
            &ldquo;{review.keyQuote}&rdquo;
          </p>
        )}
      </div>
    </article>
  );
}

const INITIAL_REVIEWS = 100;

export default function VideoCreatorDetailClient({ creator }: { creator: VideoCreatorProfile }) {
  const [sortMode, setSortMode] = useState<SortMode>('recent');
  const [showCount, setShowCount] = useState(INITIAL_REVIEWS);

  const duplicateTitles = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of creator.reviews) {
      counts.set(r.showTitle, (counts.get(r.showTitle) || 0) + 1);
    }
    const dupes = new Set<string>();
    for (const [title, n] of Array.from(counts)) {
      if (n > 1) dupes.add(title);
    }
    return dupes;
  }, [creator.reviews]);

  const sortedReviews = useMemo(() => {
    const sorted = [...creator.reviews];
    if (sortMode === 'recent') {
      sorted.sort((a, b) => {
        const da = a.publishedAt ? Date.parse(a.publishedAt) : 0;
        const db = b.publishedAt ? Date.parse(b.publishedAt) : 0;
        return db - da;
      });
    } else if (sortMode === 'highest') {
      sorted.sort((a, b) => b.score - a.score);
    } else {
      sorted.sort((a, b) => a.score - b.score);
    }
    return sorted;
  }, [creator.reviews, sortMode]);

  const visibleReviews = sortedReviews.slice(0, showCount);
  const remaining = sortedReviews.length - showCount;

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
      <Breadcrumb items={[
        { label: 'Home', href: '/' },
        { label: 'Video Critics', href: '/video-critics' },
        { label: creator.name },
      ]} />

      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-12 h-12 rounded-full bg-surface-overlay flex items-center justify-center flex-shrink-0">
            <span className="text-white font-bold text-lg">
              {creator.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
            </span>
          </div>
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-white">{creator.name}</h1>
            <div className="flex items-center gap-2 text-sm text-gray-400">
              <PlatformPill platform={creator.platform} />
              {creator.subscribers && (
                <span className="text-gray-500">{creator.subscribers} followers</span>
              )}
            </div>
          </div>
        </div>

        <StatGrid className="mb-4" stats={[
          { label: 'Reviews', value: creator.reviewCount },
          { label: 'Average', value: creator.avgScore, color: getScoreTextColor(creator.avgScore) },
          { label: 'Highest', value: creator.highScore },
          { label: 'Lowest', value: creator.lowScore },
        ]} />

        <div className="flex flex-wrap gap-3 text-sm text-gray-400">
          <span>{ordinalSuffix(creator.volumeRank)} most prolific video critic</span>
          <span className="text-gray-600">·</span>
          <span>{ordinalSuffix(creator.generosityRank)} most generous scorer</span>
        </div>
      </div>

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

      <div className="space-y-2">
        {visibleReviews.length > 0 ? (
          visibleReviews.map((review, index) => (
            <ReviewCard
              key={`${review.showId}-${review.videoUrl}`}
              review={review}
              showYear={duplicateTitles.has(review.showTitle) ? getShowYear(review) : null}
              loading={index < 4 ? 'eager' : 'lazy'}
            />
          ))
        ) : (
          <div className="card p-8 text-center">
            <p className="text-gray-400">No reviews found for this creator.</p>
          </div>
        )}
      </div>

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
